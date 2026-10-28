import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import { conversationStateSchema, type Conversation } from '@/lib/contracts';
import { SparklesIcon } from 'lucide-react';
import { api, apiEventStream } from '@/lib/api';
import {
  ConversationStarterCards,
  IdeaComposer,
} from '@/components/conversation-start';
import { taskPriorityLabels } from '@/lib/task-ui';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import {
  Message,
  MessageContent,
  MessageHeader,
} from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Spinner } from '@/components/ui/spinner';
import { useConfirmation } from '@/hooks/use-confirmation';
import { taskKey } from '@/lib/references';
import { ReferenceText } from '@/components/reference-text';

export type TaskConversationHandle = {
  ready: boolean;
  submit: (body: string) => void;
};

export const TaskConversation = forwardRef(function TaskConversation(
  {
    projectId,
    projectName,
    placement = 'sidebar',
    onOpenBoard,
    onMinimize,
    onStateChange,
  }: {
    projectId: string;
    projectName: string;
    placement?: 'page' | 'sidebar';
    onOpenBoard: () => void;
    onMinimize?: () => void;
    // Called after a proposal is created, confirmed or rejected.
    onStateChange?: () => void;
  },
  ref: Ref<TaskConversationHandle>,
) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [pendingUser, setPendingUser] = useState('');
  const [streamReply, setStreamReply] = useState('');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const sendAbort = useRef<AbortController | null>(null);
  const { confirm, confirmationDialog } = useConfirmation();
  const pending = conversation?.proposal?.status === 'pending';
  const busy = sending || resolving;
  const page = placement === 'page';
  const produced =
    conversation?.proposal?.status === 'applied'
      ? conversation.proposal.items
      : [];

  useEffect(() => {
    const controller = new AbortController();
    api(`/projects/${projectId}/conversation`, conversationStateSchema, {
      signal: controller.signal,
    })
      .then((state) => setConversation(state.conversation))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(caught instanceof Error ? caught.message : '对话加载失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, reload]);

  useEffect(() => () => sendAbort.current?.abort(), []);

  const submitBody = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed || busy || pending || loading) return;
      const abort = new AbortController();
      sendAbort.current = abort;
      setSending(true);
      setPendingUser(trimmed);
      setStreamReply('');
      setError('');
      try {
        const state = conversationStateSchema.parse(
          await apiEventStream(`/projects/${projectId}/conversation/messages`, {
            body: JSON.stringify({ body: trimmed }),
            timeoutMs: 70_000,
            signal: abort.signal,
            onReply: setStreamReply,
          }),
        );
        setConversation(state.conversation);
        onStateChange?.();
        setPendingUser('');
        setStreamReply('');
        setDraft('');
      } catch (caught) {
        if (abort.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : '生成提案失败。');
        setReload((value) => value + 1);
      } finally {
        if (!abort.signal.aborted) setSending(false);
      }
    },
    [busy, loading, onStateChange, pending, projectId],
  );

  useImperativeHandle(
    ref,
    () => ({
      ready: !loading,
      submit(body: string) {
        void submitBody(body);
      },
    }),
    [loading, submitBody],
  );

  async function resolve(decision: 'confirm' | 'reject') {
    const proposal = conversation?.proposal;
    if (!proposal || proposal.status !== 'pending') return;
    if (
      decision === 'reject' &&
      !(await confirm({
        title: '拒绝这份任务提案？',
        description: '拒绝后不会创建任务。你可以继续描述，让 AI 重新提案。',
        confirmLabel: '拒绝提案',
      }))
    )
      return;
    setResolving(true);
    setError('');
    try {
      const state = conversationStateSchema.parse(
        await api(
          `/proposals/${proposal.id}/${decision}`,
          conversationStateSchema,
          {
            method: 'POST',
            timeoutMs: 30_000,
          },
        ),
      );
      setConversation(state.conversation);
      onStateChange?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '处理提案失败。');
    } finally {
      setResolving(false);
    }
  }

  const showStarter =
    page && !loading && !sending && !conversation?.messages.length;
  const composer = (
    <IdeaComposer
      id="conversation-body"
      value={draft}
      onChange={setDraft}
      onSubmit={() => {
        void submitBody(draft);
      }}
      disabled={busy || loading}
      pending={pending}
      sending={sending}
      large={showStarter}
      bordered={!showStarter}
    />
  );

  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col"
      aria-label={`${projectName}的 AI 对话`}
    >
      {page && !showStarter && !loading ? (
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">{projectName}</h1>
            <p className="text-xs text-muted-foreground">
              确认提案后，任务才会写入看板。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onOpenBoard}>
            打开任务看板
          </Button>
        </header>
      ) : null}
      {!page ? (
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">{projectName}</h1>
            <p className="text-xs text-muted-foreground">
              描述要做的事。确认提案后，任务才会写入看板。
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={onOpenBoard}>
              打开任务看板
            </Button>
            {onMinimize ? (
              <Button variant="ghost" size="sm" onClick={onMinimize}>
                缩小
              </Button>
            ) : null}
          </div>
        </header>
      ) : null}
      {error ? (
        <div className="px-4 pt-4">
          <Alert variant="destructive">
            <AlertTitle>对话未完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      {showStarter ? (
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 overflow-y-auto px-6 py-12">
          <div className="flex flex-col gap-3">
            <h1 className="text-3xl font-medium tracking-tight">
              与 AI 一起推进这个项目。
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              描述要做的事。AI 会拆成待确认的任务，确认后才写入看板。
            </p>
          </div>
          {composer}
          <ConversationStarterCards
            disabled={busy || loading}
            onPick={(body) => {
              void submitBody(body);
            }}
          />
        </div>
      ) : (
        <>
          <MessageScrollerProvider autoScroll>
            <MessageScroller className="min-h-0 flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent className="px-4 py-6">
                  {loading ? (
                    <MessageScrollerItem messageId="loading">
                      <div
                        className="flex items-center gap-2 text-sm text-muted-foreground"
                        role="status"
                      >
                        <Spinner />
                        正在加载对话…
                      </div>
                    </MessageScrollerItem>
                  ) : null}
                  {!loading && !sending && !conversation?.messages.length ? (
                    <MessageScrollerItem messageId="empty">
                      <Empty>
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <SparklesIcon />
                          </EmptyMedia>
                          <EmptyTitle>
                            <h2>从这个项目的一件事开始</h2>
                          </EmptyTitle>
                          <EmptyDescription>
                            例如：「给注册加上邮箱验证，并补上失败提示」。AI
                            会先给出任务提案，不会直接改看板。
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </MessageScrollerItem>
                  ) : null}
                  {conversation?.messages.map((message) => (
                    <MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                      scrollAnchor={message.authorType === 'user'}
                    >
                      <Message
                        align={message.authorType === 'user' ? 'end' : 'start'}
                      >
                        <MessageContent>
                          <MessageHeader>
                            {message.authorType === 'user'
                              ? (message.authorName ?? '你')
                              : 'AI'}
                          </MessageHeader>
                          <Bubble
                            variant={
                              message.authorType === 'user'
                                ? 'default'
                                : 'muted'
                            }
                            align={
                              message.authorType === 'user' ? 'end' : 'start'
                            }
                          >
                            <BubbleContent>
                              <ReferenceText text={message.body} />
                            </BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ))}
                  {conversation?.proposal ? (
                    <MessageScrollerItem messageId={conversation.proposal.id}>
                      <Card>
                        <CardHeader>
                          <CardTitle>任务提案</CardTitle>
                          <CardDescription>
                            {conversation.proposal.status === 'pending'
                              ? '这些任务还不是正式工作。确认后才会出现在看板。'
                              : conversation.proposal.status === 'applied'
                                ? '已确认，任务已写入待办。'
                                : '已拒绝，没有创建任务。'}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-3">
                          {conversation.proposal.items.map((item) => (
                            <div
                              key={item.id}
                              className="flex flex-col gap-1 border-b pb-3 last:border-b-0 last:pb-0"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-sm font-medium">
                                  {item.title}
                                </h2>
                                <Badge variant="outline">
                                  {taskPriorityLabels[item.priority]}
                                </Badge>
                                {item.taskNumber ? (
                                  <Badge variant="secondary">
                                    {taskKey(item.taskNumber)}
                                  </Badge>
                                ) : null}
                              </div>
                              {item.description ? (
                                <p className="text-sm text-muted-foreground">
                                  <ReferenceText text={item.description} />
                                </p>
                              ) : null}
                              {item.acceptanceCriteria ? (
                                <p className="text-xs text-muted-foreground">
                                  验收：
                                  <ReferenceText
                                    text={item.acceptanceCriteria}
                                  />
                                </p>
                              ) : null}
                            </div>
                          ))}
                        </CardContent>
                        {conversation.proposal.status === 'pending' ? (
                          <CardFooter className="gap-2">
                            <Button
                              disabled={busy}
                              onClick={() => {
                                void resolve('confirm');
                              }}
                            >
                              {resolving ? (
                                <Spinner data-icon="inline-start" />
                              ) : null}
                              确认并创建任务
                            </Button>
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => {
                                void resolve('reject');
                              }}
                            >
                              拒绝
                            </Button>
                          </CardFooter>
                        ) : null}
                        {conversation.proposal.status === 'applied' ? (
                          <CardFooter>
                            <Button variant="outline" onClick={onOpenBoard}>
                              在看板中查看
                            </Button>
                          </CardFooter>
                        ) : null}
                      </Card>
                    </MessageScrollerItem>
                  ) : null}
                  {sending && pendingUser ? (
                    <MessageScrollerItem messageId="pending-user" scrollAnchor>
                      <Message align="end">
                        <MessageContent>
                          <MessageHeader>你</MessageHeader>
                          <Bubble variant="default" align="end">
                            <BubbleContent>
                              <ReferenceText text={pendingUser} />
                            </BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ) : null}
                  {sending ? (
                    <MessageScrollerItem messageId="streaming">
                      <Message align="start">
                        <MessageContent>
                          <MessageHeader>AI</MessageHeader>
                          {streamReply ? (
                            <Bubble variant="muted" align="start">
                              <BubbleContent>
                                <ReferenceText text={streamReply} />
                              </BubbleContent>
                            </Bubble>
                          ) : null}
                          <Marker>
                            <MarkerContent>
                              正在生成提案，任务尚未创建。
                            </MarkerContent>
                          </Marker>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ) : null}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>
          {page && produced.length > 0 ? (
            <div
              className="flex max-h-64 shrink-0 flex-col gap-3 overflow-y-auto border-t px-4 py-4"
              aria-label="这次产出"
            >
              <p className="text-sm font-medium">这次产出</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {produced.map((item) => (
                  <Card key={item.id} size="sm">
                    <CardHeader>
                      <CardTitle>
                        <h2>{item.title}</h2>
                      </CardTitle>
                      <CardDescription>
                        {item.taskNumber
                          ? `${taskKey(item.taskNumber)} · 已写入看板`
                          : '已写入看板'}
                      </CardDescription>
                    </CardHeader>
                    <CardFooter>
                      <Button variant="outline" size="sm" onClick={onOpenBoard}>
                        在看板中查看
                      </Button>
                    </CardFooter>
                  </Card>
                ))}
              </div>
            </div>
          ) : null}
          {composer}
        </>
      )}
      {confirmationDialog}
    </section>
  );
});
