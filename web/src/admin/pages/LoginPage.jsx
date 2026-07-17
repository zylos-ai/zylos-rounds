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
      onLoggedIn();
    } catch (err) {
      if (err.status === 401) setError('密码错误，请重试');
      else if (err.status === 429) setError('尝试次数过多，请稍后再试');
      else setError('登录失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
      <Card className="w-full max-w-[360px]">
        <CardHeader className="pt-6">
          <CardTitle className="text-base">
            <Mic className="h-[18px] w-[18px] text-primary" strokeWidth={1.75} />
            语音日报 · 管理
          </CardTitle>
          <CardDescription>输入管理密码登录</CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
              登录
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
