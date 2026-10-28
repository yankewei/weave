import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type Confirmation = {
  title: string;
  description: string;
  confirmLabel: string;
};

// Keep async navigation and destructive draft decisions behind the same accessible dialog.
export function useConfirmation() {
  const [pending, setPending] = useState<Confirmation | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  useEffect(
    () => () => {
      resolver.current?.(false);
    },
    [],
  );

  const confirm = useCallback(
    (options: Confirmation) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setPending(options);
      }),
    [],
  );

  function settle(confirmed: boolean) {
    resolver.current?.(confirmed);
    resolver.current = null;
    setPending(null);
  }

  const confirmationDialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => settle(true)}>
            {pending?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, confirmationDialog };
}
