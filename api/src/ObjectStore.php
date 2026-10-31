<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Client\HttpClient;
use Amp\Http\Client\Request;
use Amp\Http\Client\Response;

/**
 * One S3-compatible bucket: the deployment's default store or a workspace's own.
 * Requests are signed with SigV4 and use path-style URLs, which AWS, R2, RustFS
 * and most compatible stores accept.
 */
final readonly class ObjectStore
{
    private const SIGNED_HEADERS = 'host;x-amz-content-sha256;x-amz-date';

    /** @param string $endpoint An http(s) origin as origin() returns it. */
    public function __construct(
        private HttpClient $http,
        private string $endpoint,
        private string $region,
        private string $bucket,
        private string $accessKeyId,
        private string $secretAccessKey,
        public string $prefix = '',
    ) {
    }

    // An http(s) service root without credentials, as its WHATWG origin; null when it is not one.
    public static function origin(string $endpoint): ?string
    {
        $url = parse_url($endpoint);
        $scheme = strtolower($url['scheme'] ?? '');
        if (
            !in_array($scheme, ['http', 'https'], true)
            || ($url['host'] ?? '') === ''
            || isset($url['user']) || isset($url['pass'])
            || !in_array($url['path'] ?? '/', ['', '/'], true)
            || ($url['query'] ?? '') !== ''
            || ($url['fragment'] ?? '') !== ''
        ) {
            return null;
        }
        $port = $url['port'] ?? null;
        $defaultPort = $scheme === 'https' ? 443 : 80;

        return "{$scheme}://" . strtolower($url['host']) . ($port === null || $port === $defaultPort ? '' : ":{$port}");
    }

    /** The store's HTTP status; anything but 2xx means the object was not saved. */
    public function put(string $key, string $bytes, string $contentType): int
    {
        return $this->status('PUT', $key, $bytes, ['content-type' => $contentType]);
    }

    // The caller streams the body on success and must still read it on failure.
    public function get(string $key): Response
    {
        return $this->send('GET', $key);
    }

    // Best effort: an orphaned object is cheaper than failing the caller twice.
    public function delete(string $key): void
    {
        try {
            $this->status('DELETE', $key);
        } catch (\Throwable) {
            // Leave the object for manual cleanup.
        }
    }

    // Safe on every start: a bucket you already own counts as created. AWS rejects
    // a body naming us-east-1 and requires one for every other region.
    public function createBucket(float $timeout): int
    {
        $location = $this->region === 'us-east-1' ? '' : '<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            . "<LocationConstraint>{$this->region}</LocationConstraint></CreateBucketConfiguration>";
        $response = $this->send('PUT', null, $location, timeout: $timeout);
        $answer = $response->getBody()->buffer();

        return $response->getStatus() === 409 && str_contains($answer, 'BucketAlreadyOwnedByYou') ? 200 : $response->getStatus();
    }

    /**
     * Sends a request whose answer is only its status, reading the body so the
     * connection can be reused.
     *
     * @param non-empty-string $method
     * @param array<non-empty-string, string> $headers
     */
    private function status(string $method, string $key, string $body = '', array $headers = []): int
    {
        $response = $this->send($method, $key, $body, $headers);
        $response->getBody()->buffer();

        return $response->getStatus();
    }

    /**
     * @param non-empty-string $method
     * @param array<non-empty-string, string> $headers
     */
    private function send(string $method, ?string $key, string $body = '', array $headers = [], float $timeout = 30): Response
    {
        $path = '/' . rawurlencode($this->bucket)
            . ($key === null ? '' : '/' . implode('/', array_map(rawurlencode(...), explode('/', $key))));
        $request = new Request($this->endpoint . $path, $method, $body);
        $hash = hash('sha256', $body);
        $date = gmdate('Ymd\THis\Z');
        $day = substr($date, 0, 8);
        $scope = "{$day}/{$this->region}/s3/aws4_request";
        // The authority is what amphp sends as Host, which SigV4 must sign verbatim.
        $canonical = "{$method}\n{$path}\n\nhost:{$request->getUri()->getAuthority()}\nx-amz-content-sha256:{$hash}\nx-amz-date:{$date}\n\n"
            . self::SIGNED_HEADERS . "\n{$hash}";
        $toSign = "AWS4-HMAC-SHA256\n{$date}\n{$scope}\n" . hash('sha256', $canonical);
        $signingKey = 'AWS4' . $this->secretAccessKey;
        foreach ([$day, $this->region, 's3', 'aws4_request'] as $part) {
            $signingKey = hash_hmac('sha256', $part, $signingKey, true);
        }

        $request->setHeaders([
            ...$headers,
            'x-amz-content-sha256' => $hash,
            'x-amz-date' => $date,
            'authorization' => "AWS4-HMAC-SHA256 Credential={$this->accessKeyId}/{$scope}, SignedHeaders=" . self::SIGNED_HEADERS . ', Signature='
                . hash_hmac('sha256', $toSign, $signingKey),
        ]);
        $request->setTcpConnectTimeout(min($timeout, 10));
        $request->setTlsHandshakeTimeout(min($timeout, 10));
        $request->setTransferTimeout($timeout);

        return $this->http->request($request);
    }
}
