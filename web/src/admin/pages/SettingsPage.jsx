import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioLines, CheckCircle2, Copy, FileText, Globe, KeyRound, Loader2, Pencil,
  Plus, RefreshCw, Server, Square, Trash2, Volume2, XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { api } from '../api';
import { useLangDict } from '../i18n';

const DICT = {
  zh: {
    testErrors: {
      no_key: '未配置 API key',
      invalid_key: 'API key 无效（401）',
      timeout: '连接超时，请检查网络或代理',
      network: '网络错误，无法连接',
      invalid_model: '模型不可用，请检查模型名',
      bad_response: '返回格式异常，不是 OpenAI 兼容接口？',
      model_required: '该 provider 不支持模型列表，请填模型名后测试',
    },
    testFailed: (err) => `失败（${err}）`,
    slotLabels: { voice: '语音', profile: '画像', digest: '汇总' },
    slotJoiner: '、',
    // provider form
    nameLabel: '名称',
    namePlaceholder: '如 Gemini（OpenAI 兼容）',
    apiKeyKeepSuffix: '（留空不修改）',
    capModelsLabel: '支持模型列表（/v1/models）',
    capRealtimeLabel: '支持 Realtime 语音（OpenAI 协议）',
    invalidBaseUrl: 'base URL 无效（需 http/https 开头）',
    invalidName: '名称不能为空',
    slugTaken: '标识重复',
    saveFailed: '保存失败，请重试',
    save: '保存',
    cancel: '取消',
    // model picker
    providerDefaultOption: 'OpenAI 官方（默认）',
    modelLabel: '模型',
    refreshTitle: '从 provider 拉取模型列表',
    refreshList: '刷新列表',
    test: '测试',
    // page
    loading: '加载中…',
    loadFailed: '加载失败，请刷新重试',
    pageTitle: '设置',
    pageDesc: '管理模型服务 provider，并为语音对话、画像与汇总分别选择 provider 和模型',
    // providers card
    providersTitle: '模型服务 Provider',
    providersDesc: '每个 provider 一套 base URL + API key，统一按 OpenAI 兼容接口访问',
    add: '新增',
    builtinBadge: '内置',
    noKeyBadge: '未配置 key',
    keySetBadge: 'key 已配置',
    voiceBadge: '语音',
    modelListBadge: '模型列表',
    inUse: (slots) => `正在用于：${slots}`,
    testConn: '测连通',
    changeKey: '改 key',
    edit: '编辑',
    delete: '删除',
    connOk: '连接正常',
    requestFailed: '请求失败，请重试',
    inUseError: (slots) => `正在被「${slots}」使用，先把对应配置改为其他 provider`,
    deleteFailed: '删除失败，请重试',
    // voice model card
    voiceCardTitle: '对话模型',
    voiceCardDesc: '语音通话使用的 provider 与实时模型（仅支持 Realtime 语音的 provider 可选），修改后作用于下一次通话',
    voiceLabel: '音色',
    stopPreviewTitle: '停止试听',
    previewTitle: (voice) => `试听 ${voice}`,
    stop: '停止',
    preview: '试听',
    previewLoadFailed: '试听音频加载失败',
    voiceSaved: '已保存，下一次通话生效',
    modelRequired: '模型名不能为空',
    // text models card
    textCardTitle: '文本模型',
    textCardDesc: '动态画像更新与任务汇总使用的文字模型，在对话结束后异步运行，不影响语音通话',
    profileModelLabel: '画像模型',
    digestModelLabel: '汇总模型',
    defaultPlaceholder: (model) => `留空使用默认（${model}）`,
    followProfilePlaceholder: '留空则跟随画像模型',
    textSaved: '已保存，下一次画像更新 / 汇总生效',
    modelOk: (model) => `${model} 可用`,
    modelTestFailed: (model, err) => `${model}：${err}`,
    // time-zone card
    tzCardTitle: '时区',
    tzCardDesc: '影响对话里的时间感知（问候语、"今天/昨天"）和日报的归属日期',
    tzLabel: 'IANA 时区',
    tzSaved: (effective) => `已保存，当前生效：${effective}（下一次通话生效）`,
    invalidTz: '无效时区，请填 IANA 名称（如 Asia/Singapore）',
    tzFooter: (def, effective) => `留空使用默认（${def}）· 当前生效：${effective}`,
    // team default language
    langLabel: '团队默认语言',
    langDesc: '新成员和未单独设置语言的成员使用该语言；负责人看的汇总报告也用它。',
    langNames: { zh: '中文', en: 'English' },
    langDefaultOption: (name) => `默认（${name}）`,
    langEffective: (name) => `当前生效：${name}`,
    langSaved: (name) => `已保存，当前生效：${name}`,
    // API keys card
    tokensTitle: 'API 密钥',
    tokensDesc: '供 agent / CLI 远程管理使用的 Bearer 密钥，可分客户端发放、单独轮换或吊销',
    tokenNameLabel: '名称',
    tokenNamePlaceholder: '如 luna、avatar、ci',
    tokenCreate: '创建',
    tokenNameTaken: '名称已存在',
    tokenInvalidName: '名称不能为空',
    tokenPlainOnce: (name) => `「${name}」的密钥，仅显示这一次，请立即保存：`,
    tokenCopy: '复制',
    tokenCopied: '已复制',
    tokenRotate: '轮换',
    tokenRevoke: '吊销',
    tokenLegacyName: '旧版共享密钥（config.serviceToken）',
    tokenLegacyBadge: '旧版',
    tokenLegacyHint: '建议：创建命名密钥并迁移客户端后，吊销这把共享密钥',
    tokenCreatedAt: (t) => `创建于 ${t}`,
    tokenLastUsed: (t) => (t ? `最近使用 ${t}` : '从未使用'),
    tokenEmpty: '暂无命名密钥',
    tokenRevokeFailed: '吊销失败，请重试',
  },
  en: {
    testErrors: {
      no_key: 'API key not configured',
      invalid_key: 'Invalid API key (401)',
      timeout: 'Connection timed out — check network or proxy',
      network: 'Network error, unable to connect',
      invalid_model: 'Model unavailable — check the model name',
      bad_response: 'Unexpected response format — not an OpenAI-compatible API?',
      model_required: 'This provider has no model list; enter a model name before testing',
    },
    testFailed: (err) => `Failed (${err})`,
    slotLabels: { voice: 'voice', profile: 'profile', digest: 'digest' },
    slotJoiner: ', ',
    // provider form
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Gemini (OpenAI-compatible)',
    apiKeyKeepSuffix: ' (leave blank to keep)',
    capModelsLabel: 'Supports model list (/v1/models)',
    capRealtimeLabel: 'Supports Realtime voice (OpenAI protocol)',
    invalidBaseUrl: 'Invalid base URL (must start with http/https)',
    invalidName: 'Name is required',
    slugTaken: 'Identifier already taken',
    saveFailed: 'Save failed, please retry',
    save: 'Save',
    cancel: 'Cancel',
    // model picker
    providerDefaultOption: 'OpenAI (default)',
    modelLabel: 'Model',
    refreshTitle: 'Fetch model list from the provider',
    refreshList: 'Refresh list',
    test: 'Test',
    // page
    loading: 'Loading…',
    loadFailed: 'Failed to load, please refresh',
    pageTitle: 'Settings',
    pageDesc: 'Manage model providers, and pick a provider and model for voice calls, profiles, and digests',
    // providers card
    providersTitle: 'Model Providers',
    providersDesc: 'Each provider is a base URL + API key pair, accessed through the OpenAI-compatible API',
    add: 'Add',
    builtinBadge: 'Built-in',
    noKeyBadge: 'No key',
    keySetBadge: 'key configured',
    voiceBadge: 'Voice',
    modelListBadge: 'Model list',
    inUse: (slots) => `In use: ${slots}`,
    testConn: 'Test connection',
    changeKey: 'Change key',
    edit: 'Edit',
    delete: 'Delete',
    connOk: 'Connection OK',
    requestFailed: 'Request failed, please retry',
    inUseError: (slots) => `In use by ${slots} — switch those settings to another provider first`,
    deleteFailed: 'Delete failed, please retry',
    // voice model card
    voiceCardTitle: 'Conversation Model',
    voiceCardDesc: 'Provider and realtime model used for voice calls (only providers with Realtime voice support are selectable); changes apply to the next call',
    voiceLabel: 'Voice',
    stopPreviewTitle: 'Stop preview',
    previewTitle: (voice) => `Preview ${voice}`,
    stop: 'Stop',
    preview: 'Preview',
    previewLoadFailed: 'Failed to load preview audio',
    voiceSaved: 'Saved — applies to the next call',
    modelRequired: 'Model name is required',
    // text models card
    textCardTitle: 'Text Models',
    textCardDesc: 'Text models for dynamic profile updates and task digests; they run asynchronously after each call and do not affect voice conversations',
    profileModelLabel: 'Profile model',
    digestModelLabel: 'Digest model',
    defaultPlaceholder: (model) => `Leave blank for default (${model})`,
    followProfilePlaceholder: 'Leave blank to follow the profile model',
    textSaved: 'Saved — applies to the next profile update / digest',
    modelOk: (model) => `${model} works`,
    modelTestFailed: (model, err) => `${model}: ${err}`,
    // time-zone card
    tzCardTitle: 'Time Zone',
    tzCardDesc: 'Affects time awareness in conversations (greetings, "today/yesterday") and which date daily reports belong to',
    tzLabel: 'IANA time zone',
    tzSaved: (effective) => `Saved — now effective: ${effective} (applies to the next call)`,
    invalidTz: 'Invalid time zone — use an IANA name (e.g. Asia/Singapore)',
    tzFooter: (def, effective) => `Leave blank for default (${def}) · Currently effective: ${effective}`,
    // team default language
    langLabel: 'Team default language',
    langDesc: 'Used for members without their own language setting, and for owner-facing digest reports.',
    langNames: { zh: 'Chinese', en: 'English' },
    langDefaultOption: (name) => `Default (${name})`,
    langEffective: (name) => `Currently effective: ${name}`,
    langSaved: (name) => `Saved — now effective: ${name}`,
    // API keys card
    tokensTitle: 'API Keys',
    tokensDesc: 'Bearer keys for agents / CLI remote management — issue per client, rotate or revoke individually',
    tokenNameLabel: 'Name',
    tokenNamePlaceholder: 'e.g. luna, avatar, ci',
    tokenCreate: 'Create',
    tokenNameTaken: 'Name already taken',
    tokenInvalidName: 'Name is required',
    tokenPlainOnce: (name) => `Key for “${name}” — shown only once, save it now:`,
    tokenCopy: 'Copy',
    tokenCopied: 'Copied',
    tokenRotate: 'Rotate',
    tokenRevoke: 'Revoke',
    tokenLegacyName: 'Legacy shared key (config.serviceToken)',
    tokenLegacyBadge: 'Legacy',
    tokenLegacyHint: 'Recommended: create named keys, migrate clients, then revoke this shared key',
    tokenCreatedAt: (t) => `Created ${t}`,
    tokenLastUsed: (t) => (t ? `Last used ${t}` : 'Never used'),
    tokenEmpty: 'No named keys yet',
    tokenRevokeFailed: 'Revoke failed, please retry',
  },
};

// datalist suggestions only — any valid IANA zone is accepted
const TZ_SUGGESTIONS = [
  'Asia/Singapore', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo',
  'Asia/Seoul', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Kolkata', 'Asia/Dubai',
  'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'UTC',
];

const testErrorText = (T, r) => T.testErrors[r.error] || T.testFailed(r.error);


/** Inline create/edit form. The builtin provider only exposes its API key. */
function ProviderForm({ provider, onDone, onCancel }) {
  const T = useLangDict(DICT);
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
        setMsg(err.data?.error === 'invalid_base_url' ? T.invalidBaseUrl
          : err.data?.error === 'invalid_name' ? T.invalidName
          : err.data?.error === 'slug_taken' ? T.slugTaken
          : T.saveFailed);
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
              <span className="text-sm font-medium text-muted-foreground">{T.nameLabel}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={T.namePlaceholder} className="h-10 w-[220px] text-sm" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted-foreground">Base URL</span>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://..." className="h-10 w-[280px] text-sm" />
            </label>
          </>
        ) : null}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-muted-foreground">API key{!isNew ? T.apiKeyKeepSuffix : ''}</span>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." autoComplete="off" className="h-10 w-[240px] text-sm" />
        </label>
      </div>
      {!builtin ? (
        <div className="mt-3 flex flex-wrap gap-5">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={capModels} onChange={(e) => setCapModels(e.target.checked)} className="h-4 w-4 accent-primary" />
            {T.capModelsLabel}
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={capRealtime} onChange={(e) => setCapRealtime(e.target.checked)} className="h-4 w-4 accent-primary" />
            {T.capRealtimeLabel}
          </label>
        </div>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <Button type="submit" className="h-9 px-4 text-sm" disabled={busy || (isNew && (!name.trim() || !baseUrl.trim()))}>
          {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
          {T.save}
        </Button>
        <Button type="button" variant="ghost" className="h-9 px-3 text-sm text-muted-foreground" onClick={onCancel}>{T.cancel}</Button>
        {msg ? <span className="text-sm text-destructive">{msg}</span> : null}
      </div>
    </form>
  );
}

/** Management API keys: named bearer tokens (DB) + the legacy shared config key. */
function TokensCard() {
  const T = useLangDict(DICT);
  const [tokens, setTokens] = useState([]);
  const [legacy, setLegacy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState({}); // { [id|'legacy'|'create']: true }
  const [msg, setMsg] = useState(null); // { ok, text }
  // { name, token } — plaintext shown exactly once after create/rotate
  const [minted, setMinted] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api('api/tokens');
      setTokens(r.tokens);
      setLegacy(r.legacy);
    } catch { /* page-level load error handling covers the rest */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onCreate = async (e) => {
    e.preventDefault();
    if (busy.create || !newName.trim()) return;
    setBusy((s) => ({ ...s, create: true }));
    setMsg(null);
    try {
      const r = await api('api/tokens', { method: 'POST', body: { name: newName.trim() } });
      setMinted({ name: r.name, token: r.token });
      setCopied(false);
      setNewName('');
      setCreating(false);
      await load();
    } catch (err) {
      if (err.status !== 401) {
        setMsg({ ok: false, text: err.data?.error === 'name_taken' ? T.tokenNameTaken : err.data?.error === 'invalid_name' ? T.tokenInvalidName : T.saveFailed });
      }
    } finally {
      setBusy((s) => ({ ...s, create: false }));
    }
  };

  const onRotate = async (t) => {
    if (busy[t.id]) return;
    setBusy((s) => ({ ...s, [t.id]: true }));
    setMsg(null);
    try {
      const r = await api(`api/tokens/${t.id}/rotate`, { method: 'POST', body: {} });
      setMinted({ name: r.name, token: r.token });
      setCopied(false);
      await load();
    } catch (err) {
      if (err.status !== 401) setMsg({ ok: false, text: T.requestFailed });
    } finally {
      setBusy((s) => ({ ...s, [t.id]: false }));
    }
  };

  const onRevoke = async (key, apiPath) => {
    if (busy[key]) return;
    setBusy((s) => ({ ...s, [key]: true }));
    setMsg(null);
    try {
      await api(apiPath, { method: 'DELETE' });
      await load();
    } catch (err) {
      if (err.status !== 401) setMsg({ ok: false, text: T.tokenRevokeFailed });
    } finally {
      setBusy((s) => ({ ...s, [key]: false }));
    }
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
    } catch { /* clipboard unavailable — the token stays visible for manual copy */ }
  };

  return (
    <Card className="mt-6">
      <CardContent className="px-6 py-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
            <KeyRound className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight">{T.tokensTitle}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{T.tokensDesc}</p>
          </div>
          <Button type="button" variant="outline" className="h-9 px-3 text-sm" onClick={() => { setCreating(!creating); setMsg(null); }}>
            <Plus strokeWidth={1.75} />
            {T.add}
          </Button>
        </div>

        {creating ? (
          <form onSubmit={onCreate} className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-accent/40 p-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted-foreground">{T.tokenNameLabel}</span>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={T.tokenNamePlaceholder} autoComplete="off" className="h-10 w-[220px] text-sm" />
            </label>
            <Button type="submit" className="h-10 px-4 text-sm" disabled={busy.create || !newName.trim()}>
              {busy.create ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
              {T.tokenCreate}
            </Button>
            <Button type="button" variant="ghost" className="h-10 px-3 text-sm text-muted-foreground" onClick={() => setCreating(false)}>{T.cancel}</Button>
          </form>
        ) : null}

        {minted ? (
          <div className="mt-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
            <p className="text-sm font-medium">{T.tokenPlainOnce(minted.name)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-accent px-2 py-1 font-mono text-sm">{minted.token}</code>
              <Button type="button" variant="outline" className="h-8 px-2.5 text-sm" onClick={onCopy}>
                {copied ? <CheckCircle2 strokeWidth={1.75} /> : <Copy strokeWidth={1.75} />}
                {copied ? T.tokenCopied : T.tokenCopy}
              </Button>
            </div>
          </div>
        ) : null}

        {msg ? (
          <p className={cn('mt-3 flex items-center gap-1.5 text-sm', msg.ok ? 'text-success' : 'text-destructive')}>
            {msg.ok ? <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} /> : <XCircle className="h-4 w-4" strokeWidth={1.75} />}
            {msg.text}
          </p>
        ) : null}

        <ul className="mt-5 flex flex-col gap-3">
          {tokens.map((t) => (
            <li key={t.id} className="rounded-lg border border-border px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-[0.95rem] font-medium">{t.name}</span>
                <span className="text-xs text-muted-foreground">
                  {T.tokenCreatedAt(t.created_at)} · {T.tokenLastUsed(t.last_used_at)}
                </span>
                <span className="grow" />
                <div className="flex items-center gap-1.5">
                  <Button type="button" variant="ghost" className="h-8 px-2.5 text-sm text-muted-foreground" disabled={Boolean(busy[t.id])} onClick={() => onRotate(t)}>
                    {busy[t.id] ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : <RefreshCw strokeWidth={1.75} />}
                    {T.tokenRotate}
                  </Button>
                  <Button type="button" variant="ghost" className="h-8 px-2.5 text-sm text-muted-foreground hover:text-destructive" disabled={Boolean(busy[t.id])} onClick={() => onRevoke(t.id, `api/tokens/${t.id}`)}>
                    <Trash2 strokeWidth={1.75} />
                    {T.tokenRevoke}
                  </Button>
                </div>
              </div>
            </li>
          ))}
          {legacy ? (
            <li className="rounded-lg border border-border px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-[0.95rem] font-medium">{T.tokenLegacyName}</span>
                <Badge>{T.tokenLegacyBadge}</Badge>
                <span className="grow" />
                <Button type="button" variant="ghost" className="h-8 px-2.5 text-sm text-muted-foreground hover:text-destructive" disabled={Boolean(busy.legacy)} onClick={() => onRevoke('legacy', 'api/tokens/legacy')}>
                  {busy.legacy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : <Trash2 strokeWidth={1.75} />}
                  {T.tokenRevoke}
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{T.tokenLegacyHint}</p>
            </li>
          ) : null}
          {!tokens.length && !legacy ? (
            <li className="text-sm text-muted-foreground">{T.tokenEmpty}</li>
          ) : null}
        </ul>
      </CardContent>
    </Card>
  );
}

/** provider dropdown + model text input with datalist suggestions + optional refresh/test. */
function ModelPicker({ idBase, providers, realtimeOnly, providerValue, onProviderChange, modelValue, onModelChange, modelPlaceholder, suggestions, onRefresh, refreshBusy, onTest, testState }) {
  const T = useLangDict(DICT);
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
            <option value="">{T.providerDefaultOption}</option>
            {list.filter((p) => !p.is_builtin).map((p) => (
              <option key={p.slug} value={p.slug}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-muted-foreground">{T.modelLabel}</span>
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
          <Button type="button" variant="outline" className="h-11 px-4 text-[0.95rem]" disabled={refreshBusy} onClick={onRefresh} title={T.refreshTitle}>
            {refreshBusy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : <RefreshCw strokeWidth={1.75} />}
            {T.refreshList}
          </Button>
        ) : null}
        {onTest ? (
          <Button type="button" variant="outline" className="h-11 px-4 text-[0.95rem]" disabled={testState?.busy} onClick={onTest}>
            {testState?.busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
            {T.test}
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
  const T = useLangDict(DICT);
  const [settings, setSettings] = useState(null);
  const [providers, setProviders] = useState([]);
  const [loadError, setLoadError] = useState(false);

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

  // time-zone card state
  const [tz, setTz] = useState('');
  const [tzBusy, setTzBusy] = useState(false);
  const [tzMsg, setTzMsg] = useState(null);
  const tzMsgTimer = useRef(null);

  // team-default-language state (lives in the time-zone card)
  const [language, setLanguage] = useState('');
  const [langBusy, setLangBusy] = useState(false);
  const [langMsg, setLangMsg] = useState(null);
  const langMsgTimer = useRef(null);

  // model suggestion cache per provider slug ('' = builtin)
  const [modelCache, setModelCache] = useState({});
  const [refreshBusy, setRefreshBusy] = useState({}); // { [cacheKey]: true }

  // voice names are protocol-specific: show the list matching the selected
  // voice provider's protocol (OpenAI marin/cedar/… vs Gemini Puck/Charon/…)
  const voiceProtocol = providers.find((p) => p.slug === (voiceProvider || 'openai'))?.protocol || 'openai';
  const voiceOptions = (voiceProtocol === 'gemini' ? settings?.gemini_voice_options : settings?.voice_options) || [];

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
    // samples are per-model (same voice name sounds different across models):
    // pass the model currently selected in the card so the preview matches
    // what saving would actually sound like
    const audio = new Audio(`api/settings/voice-sample/${voice}${model ? `?model=${encodeURIComponent(model)}` : ''}`);
    audioRef.current = audio;
    setPreviewing(true);
    audio.onended = () => { audioRef.current = null; setPreviewing(false); };
    audio.onerror = () => {
      audioRef.current = null;
      setPreviewing(false);
      flash(setModelMsg, msgTimer, { ok: false, text: T.previewLoadFailed });
    };
    audio.play().catch(() => {
      audioRef.current = null;
      setPreviewing(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewing, voice, model, stopPreview, T]);

  useEffect(() => () => stopPreview(), [stopPreview]);

  // switching the provider to the other protocol invalidates the selected
  // voice — snap to that protocol's first option
  useEffect(() => {
    if (voice && voiceOptions.length && !voiceOptions.includes(voice)) {
      stopPreview();
      setVoice(voiceOptions[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, voiceOptions.join(','), stopPreview]);

  const load = useCallback(async () => {
    setLoadError(false);
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
      setTz(data.time_zone || '');
      setLanguage(data.language || '');
    } catch (err) {
      if (err.status !== 401) setLoadError(true);
    }
  }, []);

  const onSaveTz = useCallback(async (e) => {
    e?.preventDefault();
    if (tzBusy) return;
    setTzBusy(true);
    try {
      const data = await api('api/settings', { method: 'PUT', body: { time_zone: tz.trim() } });
      setSettings(data);
      setTz(data.time_zone || '');
      flash(setTzMsg, tzMsgTimer, { ok: true, text: T.tzSaved(data.time_zone_effective) });
    } catch (err) {
      if (err.status !== 401) {
        flash(setTzMsg, tzMsgTimer, {
          ok: false,
          text: err.data?.error === 'invalid_time_zone' ? T.invalidTz : T.saveFailed,
        });
      }
    } finally {
      setTzBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz, tzBusy, T]);

  const onSaveLang = useCallback(async (e) => {
    e?.preventDefault();
    if (langBusy) return;
    setLangBusy(true);
    try {
      const data = await api('api/settings', { method: 'PUT', body: { language } });
      setSettings(data);
      setLanguage(data.language || '');
      flash(setLangMsg, langMsgTimer, { ok: true, text: T.langSaved(T.langNames[data.language_effective] || data.language_effective) });
    } catch (err) {
      if (err.status !== 401) flash(setLangMsg, langMsgTimer, { ok: false, text: T.saveFailed });
    } finally {
      setLangBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, langBusy, T]);

  useEffect(() => {
    load();
    return () => {
      clearTimeout(msgTimer.current);
      clearTimeout(textMsgTimer.current);
      clearTimeout(tzMsgTimer.current);
      clearTimeout(langMsgTimer.current);
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
      setProvMsg({ slug: p.slug, ok: r.ok, text: r.ok ? T.connOk : testErrorText(T, r) });
    } catch (err) {
      if (err.status !== 401) {
        setProvMsg({ slug: p.slug, ok: false, text: err.data?.error === 'model_required' ? T.testErrors.model_required : T.requestFailed });
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
        const slots = (err.data?.slots || []).map((s) => T.slotLabels[s] || s).join(T.slotJoiner);
        setProvMsg({ slug: p.slug, ok: false, text: err.data?.error === 'in_use' ? T.inUseError(slots) : T.deleteFailed });
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
      flash(setModelMsg, msgTimer, { ok: true, text: T.voiceSaved });
      reloadProviders();
    } catch (err) {
      if (err.status !== 401) flash(setModelMsg, msgTimer, { ok: false, text: err.data?.error === 'invalid_model' ? T.modelRequired : T.saveFailed });
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
      flash(setTextMsg, textMsgTimer, { ok: true, text: T.textSaved });
      reloadProviders();
    } catch (err) {
      if (err.status !== 401) flash(setTextMsg, textMsgTimer, { ok: false, text: T.saveFailed });
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
        [which]: { busy: false, result: r.ok ? { ok: true, text: T.modelOk(testModel) } : { ok: false, text: T.modelTestFailed(testModel, testErrorText(T, r)) } },
      }));
    } catch (err) {
      setTextTest((s) => ({ ...s, [which]: { busy: false, result: err.status !== 401 ? { ok: false, text: T.requestFailed } : null } }));
    }
  };

  if (settings === null) {
    return <p className="text-sm text-muted-foreground">{loadError ? T.loadFailed : T.loading}</p>;
  }

  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">{T.pageTitle}</h1>
      <p className="mt-3 text-base text-muted-foreground">{T.pageDesc}</p>

      {loadError ? <p className="mt-6 text-sm text-destructive">{T.loadFailed}</p> : null}

      {/* providers */}
      <Card className="mt-8">
        <CardContent className="px-6 py-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
              <Server className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold leading-tight">{T.providersTitle}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{T.providersDesc}</p>
            </div>
            <Button type="button" variant="outline" className="h-9 px-3 text-sm" onClick={() => setEditing(editing === 'new' ? null : 'new')}>
              <Plus strokeWidth={1.75} />
              {T.add}
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
                  {p.is_builtin ? <Badge variant="accent">{T.builtinBadge}</Badge> : null}
                  {p.key_source === 'none'
                    ? <Badge>{T.noKeyBadge}</Badge>
                    : <Badge variant="success">{T.keySetBadge}</Badge>}
                  {p.cap_realtime ? <Badge>{T.voiceBadge}</Badge> : null}
                  {p.cap_models ? <Badge>{T.modelListBadge}</Badge> : null}
                  {p.in_use.length ? (
                    <span className="text-xs text-muted-foreground">{T.inUse(p.in_use.map((s) => T.slotLabels[s] || s).join(T.slotJoiner))}</span>
                  ) : null}
                  <span className="grow" />
                  <div className="flex items-center gap-1.5">
                    <Button type="button" variant="ghost" className="h-8 px-2.5 text-sm text-muted-foreground" disabled={Boolean(provBusy[p.slug])} onClick={() => onTestProvider(p)}>
                      {provBusy[p.slug] === 'test' ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
                      {T.testConn}
                    </Button>
                    <Button type="button" variant="ghost" className="h-8 px-2.5 text-sm text-muted-foreground" onClick={() => setEditing(editing === p.slug ? null : p.slug)}>
                      <Pencil strokeWidth={1.75} />
                      {p.is_builtin ? T.changeKey : T.edit}
                    </Button>
                    {!p.is_builtin ? (
                      <Button type="button" variant="ghost" className="h-8 px-2.5 text-sm text-muted-foreground hover:text-destructive" disabled={Boolean(provBusy[p.slug])} onClick={() => onDeleteProvider(p)}>
                        {provBusy[p.slug] === 'delete' ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : <Trash2 strokeWidth={1.75} />}
                        {T.delete}
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
              <h2 className="text-lg font-semibold leading-tight">{T.voiceCardTitle}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{T.voiceCardDesc}</p>
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
                <span className="text-sm font-medium text-muted-foreground">{T.voiceLabel}</span>
                <select
                  value={voice}
                  onChange={(e) => { stopPreview(); setVoice(e.target.value); }}
                  className="h-11 min-w-[160px] rounded-md border border-input bg-transparent px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {voiceOptions.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                variant="outline"
                className={cn('h-11 px-4 text-[0.95rem]', previewing && 'text-primary')}
                onClick={onPreview}
                title={previewing ? T.stopPreviewTitle : T.previewTitle(voice)}
              >
                {previewing ? <Square strokeWidth={1.75} /> : <Volume2 strokeWidth={1.75} />}
                {previewing ? T.stop : T.preview}
              </Button>
              <Button type="submit" className="h-11 px-6 text-[0.95rem]" disabled={modelBusy || !model.trim()}>
                {modelBusy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
                {T.save}
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
              <h2 className="text-lg font-semibold leading-tight">{T.textCardTitle}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{T.textCardDesc}</p>
            </div>
          </div>

          <form onSubmit={onSaveTextModels} className="mt-6 flex flex-col gap-5">
            <div>
              <p className="mb-2 text-sm font-semibold">{T.profileModelLabel}</p>
              <ModelPicker
                idBase="profile-models"
                providers={providers}
                providerValue={profileProvider}
                onProviderChange={(v) => { setProfileProvider(v); setTextTest((s) => ({ ...s, profile: undefined })); }}
                modelValue={profileModel}
                onModelChange={(v) => { setProfileModel(v); setTextTest((s) => ({ ...s, profile: undefined })); }}
                modelPlaceholder={T.defaultPlaceholder(settings.profile_model_default)}
                suggestions={suggestionsFor(profileProvider)}
                onRefresh={() => refreshModels(profileProvider)}
                refreshBusy={Boolean(refreshBusy[profileProvider || 'openai'])}
                onTest={() => onTestTextModel('profile')}
                testState={textTest.profile}
              />
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold">{T.digestModelLabel}</p>
              <ModelPicker
                idBase="digest-models"
                providers={providers}
                providerValue={digestProvider}
                onProviderChange={(v) => { setDigestProvider(v); setTextTest((s) => ({ ...s, digest: undefined })); }}
                modelValue={digestModel}
                onModelChange={(v) => { setDigestModel(v); setTextTest((s) => ({ ...s, digest: undefined })); }}
                modelPlaceholder={settings.digest_model_default ? T.defaultPlaceholder(settings.digest_model_default) : T.followProfilePlaceholder}
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
                {T.save}
              </Button>
            </div>
          </form>

          {textMsg ? (
            <p className={cn('mt-3 text-sm', textMsg.ok ? 'text-success' : 'text-destructive')}>{textMsg.text}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* time zone + team default language */}
      <Card className="mt-6">
        <CardContent className="px-6 py-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
              <Globe className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div>
              <h2 className="text-lg font-semibold leading-tight">{T.tzCardTitle}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{T.tzCardDesc}</p>
            </div>
          </div>

          <form onSubmit={onSaveTz} className="mt-6 flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted-foreground">{T.tzLabel}</span>
              <Input
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                placeholder={settings.time_zone_default}
                autoComplete="off"
                list="tz-suggestions"
                className="h-11 w-[260px] max-w-full text-base"
              />
              <datalist id="tz-suggestions">
                {TZ_SUGGESTIONS.map((z) => <option key={z} value={z} />)}
              </datalist>
            </label>
            <Button type="submit" className="h-11 px-6 text-[0.95rem]" disabled={tzBusy}>
              {tzBusy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
              {T.save}
            </Button>
          </form>
          <p className="mt-2 text-sm text-muted-foreground">{T.tzFooter(settings.time_zone_default, settings.time_zone_effective)}</p>

          {tzMsg ? (
            <p className={cn('mt-3 text-sm', tzMsg.ok ? 'text-success' : 'text-destructive')}>{tzMsg.text}</p>
          ) : null}

          <form onSubmit={onSaveLang} className="mt-8 flex flex-wrap items-end gap-4 border-t border-border pt-6">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted-foreground">{T.langLabel}</span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="h-11 min-w-[200px] rounded-md border border-input bg-transparent px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">{T.langDefaultOption(T.langNames[settings.language_default] || settings.language_default)}</option>
                <option value="zh">{T.langNames.zh}</option>
                <option value="en">{T.langNames.en}</option>
              </select>
            </label>
            <Button type="submit" className="h-11 px-6 text-[0.95rem]" disabled={langBusy}>
              {langBusy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
              {T.save}
            </Button>
          </form>
          <p className="mt-2 text-sm text-muted-foreground">{T.langDesc} · {T.langEffective(T.langNames[settings.language_effective] || settings.language_effective)}</p>

          {langMsg ? (
            <p className={cn('mt-3 text-sm', langMsg.ok ? 'text-success' : 'text-destructive')}>{langMsg.text}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* management API keys */}
      <TokensCard />
    </>
  );
}
