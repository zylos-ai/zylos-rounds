import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, AudioLines, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { api } from '../api';

const TEST_ERRORS = {
  no_key: '未配置 API key，请先保存一个 key',
  invalid_key: 'API key 无效（401）',
  timeout: '连接超时，请检查网络或代理',
  network: '网络错误，无法连接 OpenAI',
};

export default function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [loadError, setLoadError] = useState('');

  // key card state
  const [keyInput, setKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState(null); // { ok, text }
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, text }

  // model card state
  const [model, setModel] = useState('');
  const [voice, setVoice] = useState('');
  const [modelBusy, setModelBusy] = useState(false);
  const [modelMsg, setModelMsg] = useState(null);
  const msgTimer = useRef(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const data = await api('api/settings');
      setSettings(data);
      setModel(data.model);
      setVoice(data.voice);
    } catch (err) {
      if (err.status !== 401) setLoadError('加载失败，请刷新重试');
    }
  }, []);

  useEffect(() => {
    load();
    return () => clearTimeout(msgTimer.current);
  }, [load]);

  const flash = (setter, msg) => {
    setter(msg);
    clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setter(null), 4000);
  };

  const onSaveKey = async (e) => {
    e.preventDefault();
    const key = keyInput.trim();
    if (!key || keyBusy) return;
    setKeyBusy(true);
    setTestResult(null);
    try {
      const data = await api('api/settings', { method: 'PUT', body: { openai_key: key } });
      setSettings(data);
      setKeyInput('');
      flash(setKeyMsg, { ok: true, text: '已保存' });
    } catch (err) {
      if (err.status !== 401) flash(setKeyMsg, { ok: false, text: '保存失败，请重试' });
    } finally {
      setKeyBusy(false);
    }
  };

  const onClearKey = async () => {
    if (keyBusy) return;
    setKeyBusy(true);
    setTestResult(null);
    try {
      const data = await api('api/settings', { method: 'PUT', body: { clear_openai_key: true } });
      setSettings(data);
      flash(setKeyMsg, { ok: true, text: '已清除' });
    } catch (err) {
      if (err.status !== 401) flash(setKeyMsg, { ok: false, text: '清除失败，请重试' });
    } finally {
      setKeyBusy(false);
    }
  };

  const onTest = async () => {
    if (testBusy) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      const r = await api('api/settings/test-connection', { method: 'POST' });
      if (r.ok) setTestResult({ ok: true, text: '连接正常' });
      else setTestResult({ ok: false, text: TEST_ERRORS[r.error] || `连接失败（${r.error}）` });
    } catch (err) {
      if (err.status !== 401) setTestResult({ ok: false, text: '请求失败，请重试' });
    } finally {
      setTestBusy(false);
    }
  };

  const onSaveModel = async (e) => {
    e.preventDefault();
    if (modelBusy) return;
    setModelBusy(true);
    try {
      const data = await api('api/settings', { method: 'PUT', body: { model, voice } });
      setSettings(data);
      flash(setModelMsg, { ok: true, text: '已保存，下一次通话生效' });
    } catch (err) {
      if (err.status !== 401) flash(setModelMsg, { ok: false, text: '保存失败，请重试' });
    } finally {
      setModelBusy(false);
    }
  };

  if (settings === null) {
    return <p className="text-sm text-muted-foreground">{loadError || '加载中…'}</p>;
  }

  const source = settings.openai_key_source;

  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">设置</h1>
      <p className="mt-3 text-base text-muted-foreground">配置语音对话使用的 OpenAI 连接、模型和音色</p>

      {loadError ? <p className="mt-6 text-sm text-destructive">{loadError}</p> : null}

      {/* OpenAI connection */}
      <Card className="mt-8">
        <CardContent className="px-6 py-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
              <KeyRound className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div>
              <h2 className="text-lg font-semibold leading-tight">OpenAI 连接</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">语音对话需要一个 OpenAI API key</p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">当前状态</span>
            {source === 'env' ? (
              <>
                <Badge variant="success">已配置</Badge>
                <span className="text-sm text-muted-foreground">已通过服务器 .env 配置（优先生效，页面配置的 key 不会被使用）</span>
              </>
            ) : source === 'db' ? (
              <>
                <Badge variant="success">已配置</Badge>
                <span className="text-sm text-muted-foreground">key 保存在系统里，出于安全不会显示</span>
                <Button variant="ghost" className="h-8 px-3 text-sm text-muted-foreground hover:text-destructive" disabled={keyBusy} onClick={onClearKey}>
                  清除
                </Button>
              </>
            ) : (
              <>
                <Badge>未配置</Badge>
                <span className="text-sm text-muted-foreground">保存一个 key 后语音对话才能使用</span>
              </>
            )}
          </div>

          <form onSubmit={onSaveKey} className="mt-4 flex flex-wrap items-center gap-3">
            <Input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              className="h-11 max-w-[420px] flex-1 text-base"
              aria-label="OpenAI API key"
            />
            <Button type="submit" className="h-11 px-6 text-[0.95rem]" disabled={keyBusy || !keyInput.trim()}>
              {keyBusy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
              保存
            </Button>
            <Button type="button" variant="outline" className="h-11 px-6 text-[0.95rem]" disabled={testBusy} onClick={onTest}>
              {testBusy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
              测试连接
            </Button>
          </form>

          {keyMsg ? (
            <p className={cn('mt-3 text-sm', keyMsg.ok ? 'text-success' : 'text-destructive')}>{keyMsg.text}</p>
          ) : null}
          {testResult ? (
            <p className={cn('mt-3 flex items-center gap-1.5 text-sm', testResult.ok ? 'text-success' : 'text-destructive')}>
              {testResult.ok ? <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} /> : <XCircle className="h-4 w-4" strokeWidth={1.75} />}
              {testResult.text}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* model & voice */}
      <Card className="mt-6">
        <CardContent className="px-6 py-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
              <AudioLines className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div>
              <h2 className="text-lg font-semibold leading-tight">对话模型</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">修改后立即生效，作用于下一次开始的通话</p>
            </div>
          </div>

          <form onSubmit={onSaveModel} className="mt-6 flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted-foreground">模型</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-11 min-w-[220px] rounded-md border border-input bg-transparent px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {settings.model_options.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted-foreground">音色</span>
              <select
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                className="h-11 min-w-[160px] rounded-md border border-input bg-transparent px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {settings.voice_options.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </label>
            <Button type="submit" className="h-11 px-6 text-[0.95rem]" disabled={modelBusy}>
              {modelBusy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
              保存
            </Button>
          </form>

          {modelMsg ? (
            <p className={cn('mt-3 text-sm', modelMsg.ok ? 'text-success' : 'text-destructive')}>{modelMsg.text}</p>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
