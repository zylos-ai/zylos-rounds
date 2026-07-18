import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioLines, CheckCircle2, FileText, Loader2, Pencil, Plus, RefreshCw,
  Server, Square, Trash2, Volume2, XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { api } from '../api';

const TEST_ERRORS = {
  no_key: '未配置 API key',
  invalid_key: 'API key 无效（401）',
  timeout: '连接超时，请检查网络或代理',
  network: '网络错误，无法连接',
  invalid_model: '模型不可用，请检查模型名',
  bad_response: '返回格式异常，不是 OpenAI 兼容接口？',
  model_required: '该 provider 不支持模型列表，请填模型名后测试',
};

const SLOT_LABELS = { voice: '语音', profile: '画像', digest: '汇总' };

const testErrorText = (r) => TEST_ERRORS[r.error] || `失败（${r.error}）`;

/** Inline create/edit form. The builtin provider only exposes its API key. */
function ProviderForm({ provider, onDone, onCancel }) {
  const isNew = !provider;
  const builtin = provider?.is_builtin;
  const [name, setName] = useState(provider?.name || '');
  const [baseUrl, setBaseUrl] = useState(provider?.base_url || '');
  const [apiKey, setApiKey] = useState('');
  const [capRealtime, setCapRealtime] = useState(Boolean(provider?.cap_realtime));
  const [capModels, setCapModels] = useState(provider ? Boolean(provider.cap_models) : true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      if (isNew) {
        const body = { name: name.trim(), base_url: baseUrl.trim(), cap_realtime: capRealtime, cap_models: capModels };
        if (apiKey.trim()) body.api_key = apiKey.trim();
        await api('api/providers', { method: 'POST', body });
      } else if (builtin) {
        if (apiKey.trim()) await api(`api/providers/${provider.slug}`, { method: 'PUT', body: { api_key: apiKey.trim() } });
      } else {
        const body = { name: name.trim(), base_url: baseUrl.trim(), cap_realtime: capRealtime, cap_models: capModels };
        if (apiKey.trim()) body.api_key = apiKey.trim();
        await api(`api/providers/${provider.slug}`, { method: 'PUT', body });
      }
      onDone();
    } catch (err) {
      if (err.status !== 401) {
        setMsg(err.data?.error === 'invalid_base_url' ? 'base URL 无效（需 http/https 开头）'
          : err.data?.error === 'invalid_name' ? '名称不能为空'
          : err.data?.error === 'slug_taken' ? '标识重复'
          : '保存失败，请重试');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 rounded-lg border border-border bg-accent/40 p-4">
      <div className="flex flex-wrap items-end gap-3">
        {!builtin ? (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted-foreground">名称</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 Gemini（OpenAI 兼容）" className="h-10 w-[220px] text-sm" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted-foreground">Base URL</span>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://..." className="h-10 w-[280px] text-sm" />
            </label>
          </>
        ) : null}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-muted-foreground">API key{!isNew ? '（留空不修改）' : ''}</span>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." autoComplete="off" className="h-10 w-[240px] text-sm" />
        </label>
      </div>
      {!builtin ? (
        <div className="mt-3 flex flex-wrap gap-5">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={capModels} onChange={(e) => setCapModels(e.target.checked)} className="h-4 w-4 accent-primary" />
            支持模型列表（/v1/models）
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={capRealtime} onChange={(e) => setCapRealtime(e.target.checked)} className="h-4 w-4 accent-primary" />
            支持 Realtime 语音（OpenAI 协议）
          </label>
        </div>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <Button type="submit" className="h-9 px-4 text-sm" disabled={busy || (isNew && (!name.trim() || !baseUrl.trim()))}>
          {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
          保存
        </Button>
        <Button type="button" variant="ghost" className="h-9 px-3 text-sm text-muted-foreground" onClick={onCancel}>取消</Button>
        {msg ? <span className="text-sm text-destructive">{msg}</span> : null}
      </div>
    </form>
  );
}

/** provider dropdown + model text input with datalist suggestions + optional refresh/test. */
function ModelPicker({ idBase, providers, realtimeOnly, providerValue, onProviderChange, modelValue, onModelChange, modelPlaceholder, suggestions, onRefresh, refreshBusy, onTest, testState }) {
  const list = realtimeOnly ? providers.filter((p) => p.cap_realtime) : providers;
  const selected = providers.find((p) => p.slug === (providerValue || 'openai'));
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-muted-foreground">Provider</span>
          <select
            value={providerValue}
            onChange={(e) => onProviderChange(e.target.value)}
            className="h-11 min-w-[180px] rounded-md border border-input bg-transparent px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">OpenAI 官方（默认）</option>
            {list.filter((p) => !p.is_builtin).map((p) => (
              <option key={p.slug} value={p.slug}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-muted-foreground">模型</span>
          <Input
            value={modelValue}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder={modelPlaceholder}
            autoComplete="off"
            list={idBase}
            className="h-11 w-[260px] max-w-full text-base"
            aria-label={`${idBase}-model`}
          />
          <datalist id={idBase}>
            {(suggestions || []).map((m) => <option key={m} value={m} />)}
          </datalist>
        </label>
        {selected?.cap_models && onRefresh ? (
          <Button type="button" variant="outline" className="h-11 px-4 text-[0.95rem]" disabled={refreshBusy} onClick={onRefresh} title="从 provider 拉取模型列表">
            {refreshBusy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : <RefreshCw strokeWidth={1.75} />}
            刷新列表
          </Button>
        ) : null}
        {onTest ? (
          <Button type="button" variant="outline" className="h-11 px-4 text-[0.95rem]" disabled={testState?.busy} onClick={onTest}>
            {testState?.busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
            测试
          </Button>
        ) : null}
      </div>
      {testState?.result ? (
        <p className={cn('mt-2 flex items-center gap-1.5 text-sm', testState.result.ok ? 'text-success' : 'text-destructive')}>
          {testState.result.ok ? <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} /> : <XCircle className="h-4 w-4" strokeWidth={1.75} />}
          {testState.result.text}
        </p>
      ) : null}
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [providers, setProviders] = useState([]);
  const [loadError, setLoadError] = useState('');

  // provider card state
  const [editing, setEditing] = useState(null); // slug | 'new' | null
  const [provMsg, setProvMsg] = useState(null); // { slug, ok, text }
  const [provBusy, setProvBusy] = useState({}); // { [slug]: 'test' | 'delete' }

  // voice card state
  const [voiceProvider, setVoiceProvider] = useState('');
  const [model, setModel] = useState('');
  const [voice, setVoice] = useState('');
  const [modelBusy, setModelBusy] = useState(false);
  const [modelMsg, setModelMsg] = useState(null);
  const msgTimer = useRef(null);

  // text-model card state
  const [profileProvider, setProfileProvider] = useState('');
  const [digestProvider, setDigestProvider] = useState('');
  const [profileModel, setProfileModel] = useState('');
  const [digestModel, setDigestModel] = useState('');
  const [textBusy, setTextBusy] = useState(false);
  const [textMsg, setTextMsg] = useState(null);
  const textMsgTimer = useRef(null);
  const [textTest, setTextTest] = useState({}); // { profile|digest: { busy, result } }

  // model suggestion cache per provider slug ('' = builtin)
  const [modelCache, setModelCache] = useState({});
  const [refreshBusy, setRefreshBusy] = useState({}); // { [cacheKey]: true }

  // voice preview
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef(null);

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPreviewing(false);
  }, []);

  const onPreview = useCallback(() => {
    if (previewing) return stopPreview();
    const audio = new Audio(`api/settings/voice-sample/${voice}`);
    audioRef.current = audio;
    setPreviewing(true);
    audio.onended = () => { audioRef.current = null; setPreviewing(false); };
    audio.onerror = () => {
      audioRef.current = null;
      setPreviewing(false);
      flash(setModelMsg, msgTimer, { ok: false, text: '试听音频加载失败' });
    };
    audio.play().catch(() => {
      audioRef.current = null;
      setPreviewing(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewing, voice, stopPreview]);

  useEffect(() => () => stopPreview(), [stopPreview]);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [data, prov] = await Promise.all([api('api/settings'), api('api/providers')]);
      setSettings(data);
      setProviders(prov.providers);
      setModel(data.model);
      setVoice(data.voice);
      setVoiceProvider(data.voice_provider || '');
      setProfileProvider(data.profile_provider || '');
      setDigestProvider(data.digest_provider || '');
      setProfileModel(data.profile_model || '');
      setDigestModel(data.digest_model || '');
    } catch (err) {
      if (err.status !== 401) setLoadError('加载失败，请刷新重试');
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      clearTimeout(msgTimer.current);
      clearTimeout(textMsgTimer.current);
    };
  }, [load]);

  const flash = (setter, timer, msg) => {
    setter(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setter(null), 4000);
  };

  const reloadProviders = async () => {
    try {
      const prov = await api('api/providers');
      setProviders(prov.providers);
    } catch { /* keep the stale list */ }
  };

  const onTestProvider = async (p) => {
    if (provBusy[p.slug]) return;
    setProvBusy((s) => ({ ...s, [p.slug]: 'test' }));
    setProvMsg(null);
    try {
      const r = await api(`api/providers/${p.slug}/test`, { method: 'POST', body: {} });
      setProvMsg({ slug: p.slug, ok: r.ok, text: r.ok ? '连接正常' : testErrorText(r) });
    } catch (err) {
      if (err.status !== 401) {
        setProvMsg({ slug: p.slug, ok: false, text: err.data?.error === 'model_required' ? TEST_ERRORS.model_required : '请求失败，请重试' });
      }
    } finally {
      setProvBusy((s) => ({ ...s, [p.slug]: undefined }));
    }
  };

  const onDeleteProvider = async (p) => {
    if (provBusy[p.slug]) return;
    setProvBusy((s) => ({ ...s, [p.slug]: 'delete' }));
    setProvMsg(null);
    try {
      await api(`api/providers/${p.slug}`, { method: 'DELETE' });
      await Promise.all([reloadProviders(), load()]);
    } catch (err) {
      if (err.status !== 401) {
        const slots = (err.data?.slots || []).map((s) => SLOT_LABELS[s] || s).join('、');
        setProvMsg({ slug: p.slug, ok: false, text: err.data?.error === 'in_use' ? `正在被「${slots}」使用，先把对应配置改为其他 provider` : '删除失败，请重试' });
      }
    } finally {
      setProvBusy((s) => ({ ...s, [p.slug]: undefined }));
    }
  };

  const refreshModels = async (slug) => {
    const key = slug || 'openai';
    if (refreshBusy[key]) return;
    setRefreshBusy((s) => ({ ...s, [key]: true }));
    try {
      const r = await api(`api/providers/${key}/models`);
      if (r.ok) setModelCache((s) => ({ ...s, [key]: r.models }));
    } catch { /* silent — datalist just stays as-is */ } finally {
      setRefreshBusy((s) => ({ ...s, [key]: false }));
    }
  };

  const suggestionsFor = (slug, fallback = []) => modelCache[slug || 'openai'] || fallback;

  const onSaveVoice = async (e) => {
    e.preventDefault();
    if (modelBusy) return;
    setModelBusy(true);
    try {
      const data = await api('api/settings', { method: 'PUT', body: { model: model.trim(), voice, voice_provider: voiceProvider } });
      setSettings(data);
      flash(setModelMsg, msgTimer, { ok: true, text: '已保存，下一次通话生效' });
      reloadProviders();
    } catch (err) {
      if (err.status !== 401) flash(setModelMsg, msgTimer, { ok: false, text: err.data?.error === 'invalid_model' ? '模型名不能为空' : '保存失败，请重试' });
    } finally {
      setModelBusy(false);
    }
  };

  const onSaveTextModels = async (e) => {
    e.preventDefault();
    if (textBusy) return;
    setTextBusy(true);
    try {
      const data = await api('api/settings', {
        method: 'PUT',
        body: {
          profile_model: profileModel.trim(),
          digest_model: digestModel.trim(),
          profile_provider: profileProvider,
          digest_provider: digestProvider,
        },
      });
      setSettings(data);
      setProfileModel(data.profile_model || '');
      setDigestModel(data.digest_model || '');
      setTextTest({});
      flash(setTextMsg, textMsgTimer, { ok: true, text: '已保存，下一次画像更新 / 汇总生效' });
      reloadProviders();
    } catch (err) {
      if (err.status !== 401) flash(setTextMsg, textMsgTimer, { ok: false, text: '保存失败，请重试' });
    } finally {
      setTextBusy(false);
    }
  };

  const onTestTextModel = async (which) => {
    if (textTest[which]?.busy) return;
    const input = which === 'profile' ? profileModel.trim() : digestModel.trim();
    const provSlug = which === 'profile' ? profileProvider : digestProvider;
    const fallback = which === 'profile'
      ? settings.profile_model_default
      : (settings.digest_model_default || (profileModel.trim() || settings.profile_model_default));
    const testModel = input || fallback;
    setTextTest((s) => ({ ...s, [which]: { busy: true, result: null } }));
    try {
      const r = await api('api/settings/test-text-model', { method: 'POST', body: { model: testModel, provider: provSlug } });
      setTextTest((s) => ({
        ...s,
        [which]: { busy: false, result: r.ok ? { ok: true, text: `${testModel} 可用` } : { ok: false, text: `${testModel}：${testErrorText(r)}` } },
      }));
    } catch (err) {
      setTextTest((s) => ({ ...s, [which]: { busy: false, result: err.status !== 401 ? { ok: false, text: '请求失败，请重试' } : null } }));
    }
  };

  if (settings === null) {
    return <p className="text-sm text-muted-foreground">{loadError || '加载中…'}</p>;
  }

  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">设置</h1>
      <p className="mt-3 text-base text-muted-foreground">管理模型服务 provider，并为语音对话、画像与汇总分别选择 provider 和模型</p>

      {loadError ? <p className="mt-6 text-sm text-destructive">{loadError}</p> : null}

      {/* providers */}
      <Card className="mt-8">
        <CardContent className="px-6 py-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
              <Server className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold leading-tight">模型服务 Provider</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">每个 provider 一套 base URL + API key，统一按 OpenAI 兼容接口访问</p>
            </div>
            <Button type="button" variant="outline" className="h-9 px-3 text-sm" onClick={() => setEditing(editing === 'new' ? null : 'new')}>
              <Plus strokeWidth={1.75} />
              新增
            </Button>
          </div>

          {editing === 'new' ? (
            <ProviderForm onDone={async () => { setEditing(null); await Promise.all([reloadProviders(), load()]); }} onCancel={() => setEditing(null)} />
          ) : null}

          <ul className="mt-5 flex flex-col gap-3">
            {providers.map((p) => (
              <li key={p.slug} className="rounded-lg border border-border px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-[0.95rem] font-medium">{p.name}</span>
                  {p.is_builtin ? <Badge variant="accent">内置</Badge> : null}
                  {p.key_source === 'none'
                    ? <Badge>未配置 key</Badge>
                    : <Badge variant="success">{p.key_source === 'env' ? 'key 来自 .env' : 'key 已配置'}</Badge>}
                  {p.cap_realtime ? <Badge>语音</Badge> : null}
                  {p.cap_models ? <Badge>模型列表</Badge> : null}
                  {p.in_use.length ? (
                    <span className="text-xs text-muted-foreground">正在用于：{p.in_use.map((s) => SLOT_LABELS[s]).join('、')}</span>
                  ) : null}
                  <span className="grow" />
                  <div className="flex items-center gap-1.5">
                    <Button type="button" variant="ghost" className="h-8 px-2.5 text-sm text-muted-foreground" disabled={Boolean(provBusy[p.slug])} onClick={() => onTestProvider(p)}>
                      {provBusy[p.slug] === 'test' ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
                      测连通
                    </Button>
                    <Button type="button" variant="ghost" className="h-8 px-2.5 text-sm text-muted-foreground" onClick={() => setEditing(editing === p.slug ? null : p.slug)}>
                      <Pencil strokeWidth={1.75} />
                      {p.is_builtin ? '改 key' : '编辑'}
                    </Button>
                    {!p.is_builtin ? (
                      <Button type="button" variant="ghost" className="h-8 px-2.5 text-sm text-muted-foreground hover:text-destructive" disabled={Boolean(provBusy[p.slug])} onClick={() => onDeleteProvider(p)}>
                        {provBusy[p.slug] === 'delete' ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : <Trash2 strokeWidth={1.75} />}
                        删除
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="mt-1 break-all text-xs text-muted-foreground">{p.base_url}</p>
                {provMsg && provMsg.slug === p.slug ? (
                  <p className={cn('mt-2 flex items-center gap-1.5 text-sm', provMsg.ok ? 'text-success' : 'text-destructive')}>
                    {provMsg.ok ? <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} /> : <XCircle className="h-4 w-4" strokeWidth={1.75} />}
                    {provMsg.text}
                  </p>
                ) : null}
                {editing === p.slug ? (
                  <ProviderForm provider={p} onDone={async () => { setEditing(null); await Promise.all([reloadProviders(), load()]); }} onCancel={() => setEditing(null)} />
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* voice model */}
      <Card className="mt-6">
        <CardContent className="px-6 py-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
              <AudioLines className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div>
              <h2 className="text-lg font-semibold leading-tight">对话模型</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">语音通话使用的 provider 与实时模型（仅支持 Realtime 语音的 provider 可选），修改后作用于下一次通话</p>
            </div>
          </div>

          <form onSubmit={onSaveVoice} className="mt-6 flex flex-col gap-4">
            <ModelPicker
              idBase="voice-models"
              providers={providers}
              realtimeOnly
              providerValue={voiceProvider}
              onProviderChange={setVoiceProvider}
              modelValue={model}
              onModelChange={setModel}
              modelPlaceholder="gpt-realtime-2.1"
              suggestions={suggestionsFor(voiceProvider, settings.model_options)}
              onRefresh={() => refreshModels(voiceProvider)}
              refreshBusy={Boolean(refreshBusy[voiceProvider || 'openai'])}
            />
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-muted-foreground">音色</span>
                <select
                  value={voice}
                  onChange={(e) => { stopPreview(); setVoice(e.target.value); }}
                  className="h-11 min-w-[160px] rounded-md border border-input bg-transparent px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {settings.voice_options.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                variant="outline"
                className={cn('h-11 px-4 text-[0.95rem]', previewing && 'text-primary')}
                onClick={onPreview}
                title={previewing ? '停止试听' : `试听 ${voice}`}
              >
                {previewing ? <Square strokeWidth={1.75} /> : <Volume2 strokeWidth={1.75} />}
                {previewing ? '停止' : '试听'}
              </Button>
              <Button type="submit" className="h-11 px-6 text-[0.95rem]" disabled={modelBusy || !model.trim()}>
                {modelBusy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
                保存
              </Button>
            </div>
          </form>

          {modelMsg ? (
            <p className={cn('mt-3 text-sm', modelMsg.ok ? 'text-success' : 'text-destructive')}>{modelMsg.text}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* text models (profile updater / task digest) */}
      <Card className="mt-6">
        <CardContent className="px-6 py-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
              <FileText className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div>
              <h2 className="text-lg font-semibold leading-tight">文本模型</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">动态画像更新与任务汇总使用的文字模型，在对话结束后异步运行，不影响语音通话</p>
            </div>
          </div>

          <form onSubmit={onSaveTextModels} className="mt-6 flex flex-col gap-5">
            <div>
              <p className="mb-2 text-sm font-semibold">画像模型</p>
              <ModelPicker
                idBase="profile-models"
                providers={providers}
                providerValue={profileProvider}
                onProviderChange={(v) => { setProfileProvider(v); setTextTest((s) => ({ ...s, profile: undefined })); }}
                modelValue={profileModel}
                onModelChange={(v) => { setProfileModel(v); setTextTest((s) => ({ ...s, profile: undefined })); }}
                modelPlaceholder={`留空使用默认（${settings.profile_model_default}）`}
                suggestions={suggestionsFor(profileProvider)}
                onRefresh={() => refreshModels(profileProvider)}
                refreshBusy={Boolean(refreshBusy[profileProvider || 'openai'])}
                onTest={() => onTestTextModel('profile')}
                testState={textTest.profile}
              />
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold">汇总模型</p>
              <ModelPicker
                idBase="digest-models"
                providers={providers}
                providerValue={digestProvider}
                onProviderChange={(v) => { setDigestProvider(v); setTextTest((s) => ({ ...s, digest: undefined })); }}
                modelValue={digestModel}
                onModelChange={(v) => { setDigestModel(v); setTextTest((s) => ({ ...s, digest: undefined })); }}
                modelPlaceholder={settings.digest_model_default ? `留空使用默认（${settings.digest_model_default}）` : '留空则跟随画像模型'}
                suggestions={suggestionsFor(digestProvider)}
                onRefresh={() => refreshModels(digestProvider)}
                refreshBusy={Boolean(refreshBusy[digestProvider || 'openai'])}
                onTest={() => onTestTextModel('digest')}
                testState={textTest.digest}
              />
            </div>
            <div>
              <Button type="submit" className="h-11 px-6 text-[0.95rem]" disabled={textBusy}>
                {textBusy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
                保存
              </Button>
            </div>
          </form>

          {textMsg ? (
            <p className={cn('mt-3 text-sm', textMsg.ok ? 'text-success' : 'text-destructive')}>{textMsg.text}</p>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
