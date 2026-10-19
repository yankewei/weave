'use client';

import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export type StorageForm = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
};

export function StorageFields({
  idPrefix,
  form,
  secret,
  secretRequired,
  secretDescription,
  busy,
  autoFocus = false,
  onChange,
  onSecret,
}: {
  idPrefix: string;
  form: StorageForm;
  secret: string;
  secretRequired: boolean;
  secretDescription: string;
  busy: boolean;
  autoFocus?: boolean;
  onChange: (key: keyof StorageForm, value: string) => void;
  onSecret: (value: string) => void;
}) {
  return (
    <FieldGroup>
      <Field data-disabled={busy}>
        <FieldLabel htmlFor={`${idPrefix}-endpoint`}>服务地址</FieldLabel>
        <Input
          id={`${idPrefix}-endpoint`}
          value={form.endpoint}
          onChange={(event) => onChange('endpoint', event.target.value)}
          required
          maxLength={300}
          autoFocus={autoFocus}
          disabled={busy}
          placeholder="https://账户编号.r2.cloudflarestorage.com"
        />
      </Field>
      <Field data-disabled={busy}>
        <FieldLabel htmlFor={`${idPrefix}-region`}>区域</FieldLabel>
        <Input
          id={`${idPrefix}-region`}
          value={form.region}
          onChange={(event) => onChange('region', event.target.value)}
          required
          maxLength={64}
          disabled={busy}
          placeholder="auto"
        />
        <FieldDescription>Cloudflare R2 填 auto。</FieldDescription>
      </Field>
      <Field data-disabled={busy}>
        <FieldLabel htmlFor={`${idPrefix}-bucket`}>桶</FieldLabel>
        <Input
          id={`${idPrefix}-bucket`}
          value={form.bucket}
          onChange={(event) => onChange('bucket', event.target.value)}
          required
          maxLength={63}
          disabled={busy}
        />
      </Field>
      <Field data-disabled={busy}>
        <FieldLabel htmlFor={`${idPrefix}-prefix`}>目录</FieldLabel>
        <Input
          id={`${idPrefix}-prefix`}
          value={form.prefix}
          onChange={(event) => onChange('prefix', event.target.value)}
          maxLength={200}
          disabled={busy}
          placeholder="images"
        />
        <FieldDescription>可以留空。对象会放在这个目录下。</FieldDescription>
      </Field>
      <Field data-disabled={busy}>
        <FieldLabel htmlFor={`${idPrefix}-access-key`}>访问密钥编号</FieldLabel>
        <Input
          id={`${idPrefix}-access-key`}
          value={form.accessKeyId}
          onChange={(event) => onChange('accessKeyId', event.target.value)}
          required
          maxLength={128}
          autoComplete="off"
          disabled={busy}
        />
      </Field>
      <Field data-disabled={busy}>
        <FieldLabel htmlFor={`${idPrefix}-secret`}>访问密钥</FieldLabel>
        <Input
          id={`${idPrefix}-secret`}
          type="password"
          value={secret}
          onChange={(event) => onSecret(event.target.value)}
          maxLength={256}
          autoComplete="new-password"
          required={secretRequired}
          disabled={busy}
        />
        <FieldDescription>{secretDescription}</FieldDescription>
      </Field>
    </FieldGroup>
  );
}
