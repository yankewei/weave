<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\ByteStream\ReadableStream;
use Amp\ByteStream\ReadableStreamIteratorAggregate;
use Amp\Cancellation;
use Amp\CancelledException;
use Amp\CompositeCancellation;
use Amp\DeferredCancellation;
use Amp\DeferredFuture;
use Amp\TimeoutCancellation;
use Revolt\EventLoop;

use function Amp\async;

/**
 * Pull-based SSE relay. No message buffering: downstream backpressure reaches the
 * upstream stream, while authorization still runs independently of downstream reads.
 * @implements \IteratorAggregate<int, string>
 */
final class ConversationStream implements ReadableStream, \IteratorAggregate
{
    use ReadableStreamIteratorAggregate;

    private bool $closed = false;
    private bool $checking = false;
    private readonly string $timer;
    /** @var DeferredFuture<null> */
    private readonly DeferredFuture $onClose;

    /**
     * @param \Closure(): void $authorize
     * @param \Closure(): void $disconnect
     */
    public function __construct(private readonly ReadableStream $upstream, private readonly DeferredCancellation $cancel, \Closure $authorize, \Closure $disconnect)
    {
        $this->onClose = new DeferredFuture();
        $this->timer = EventLoop::repeat(15, function () use ($authorize, $disconnect): void {
            if ($this->checking || $this->closed) {
                return;
            }
            $this->checking = true;
            $check = async($authorize);
            try {
                $check->await(new TimeoutCancellation(3));
            } catch (\Throwable) {
                $check->ignore();
                $this->close();
                $disconnect();
            } finally {
                $this->checking = false;
            }
        });
        EventLoop::unreference($this->timer);
    }

    public function read(?Cancellation $cancellation = null): ?string
    {
        if ($this->closed) {
            return null;
        }
        try {
            $chunk = $this->upstream->read($cancellation === null ? $this->cancel->getCancellation() : new CompositeCancellation($cancellation, $this->cancel->getCancellation()));
        } catch (CancelledException $error) {
            if (!$this->cancel->isCancelled()) {
                throw $error;
            }
            $chunk = null;
        } catch (\Throwable) {
            $chunk = null;
        }
        if ($chunk === null) {
            $this->close();
        }

        return $chunk;
    }

    public function close(): void
    {
        if ($this->closed) {
            return;
        }
        $this->closed = true;
        EventLoop::cancel($this->timer);
        $this->cancel->cancel();
        $this->upstream->close();
        $this->onClose->complete();
    }

    public function isReadable(): bool
    {
        return !$this->closed && $this->upstream->isReadable();
    }

    public function isClosed(): bool
    {
        return $this->closed;
    }

    public function onClose(\Closure $onClose): void
    {
        $this->onClose->getFuture()->finally($onClose);
    }
}
