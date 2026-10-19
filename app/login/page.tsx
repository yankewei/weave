import { redirect } from 'next/navigation';
import { AuthScreen } from '@/components/auth-screen';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await currentUser()) redirect('/');
  return <AuthScreen />;
}
