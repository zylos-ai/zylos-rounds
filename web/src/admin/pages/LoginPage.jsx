import { useState } from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '../api';

export default function LoginPage({ onLoggedIn }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('api/auth/login', { method: 'POST', body: { password } });
      await onLoggedIn();
    } catch (err) {
      if (err.status === 401) setError('密码错误，请重试');
      else if (err.status === 429) setError('尝试次数过多，请稍后再试');
      else if (err.message === 'date_fetch_failed') setError('登录成功但服务端连接异常，请重试');
      else setError('登录失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
      <Card className="w-full max-w-[420px]">
        <CardHeader className="pt-8">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Mic className="h-6 w-6" strokeWidth={2} />
          </span>
          <CardTitle className="text-2xl font-bold tracking-tight">Rounds</CardTitle>
          <CardDescription className="text-[0.95rem]">输入管理密码进入管理后台</CardDescription>
        </CardHeader>
        <CardContent className="pb-8 pt-2">
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                autoFocus
                autoComplete="current-password"
                className="h-11 text-base"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="h-11 text-[0.95rem]" disabled={busy || !password}>
              {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
              登录
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
