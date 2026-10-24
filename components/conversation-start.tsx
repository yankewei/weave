'use client';

import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from 'cn';

const starters = [
  {
    title: '给注册加上失败提示',
    description: '拆成待确认任务，并写上验收标准。',
    body: '给注册加上失败提示，并写清怎样算做完。',
  },
  {
    title: '把目标拆成任务',
    description: '把一件还没拆开的事变成可执行的待办。',
    body: '把「新用户完成注册并收到结果」拆成可执行任务，每项带验收标准。',
  },
  {
    title: '补一份上线检查清单',
    description: '拆成待确认任务，每项写清验收标准。',
    body: '为这个项目补一份上线检查清单，拆成待办任务，每项写清验收标准。',
  },
] as const;

export function ConversationStarterCards({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (body: string) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3" aria-label="可以从这里开始">
      {starters.map((starter) => (
        <Card key={starter.title} size="sm">
          <CardHeader>
            <CardTitle>
              <h2>{starter.title}</h2>
            </CardTitle>
            <CardDescription>{starter.description}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-label={`用「${starter.title}」开始`}
              onClick={() => {
                onPick(starter.body);
              }}
            >
              从这里开始
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}

export function IdeaComposer({
  id,
  value,
  onChange,
  onSubmit,
  disabled,
  pending = false,
  sending = false,
  large = false,
  bordered = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  pending?: boolean;
  sending?: boolean;
  large?: boolean;
  bordered?: boolean;
}) {
  // A pending proposal still allows questions; the server just won't propose again.
  const locked = disabled;
  return (
    <form
      className={cn('shrink-0', bordered && 'border-t px-4 py-4')}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <FieldGroup>
        <Field data-disabled={locked}>
          <FieldLabel htmlFor={id}>提问或描述想做的事</FieldLabel>
          <Textarea
            id={id}
            name="body"
            required
            maxLength={8000}
            value={value}
            disabled={locked}
            placeholder={
              pending
                ? '有提案等你确认，可以先继续提问'
                : '例如：WV-14 进展如何？或者描述目标、约束和怎样算做完'
            }
            {...(large ? { className: 'min-h-40' } : {})}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </Field>
        <Button type="submit" disabled={locked}>
          {sending ? <Spinner data-icon="inline-start" /> : null}
          发送给 AI
        </Button>
      </FieldGroup>
    </form>
  );
}
