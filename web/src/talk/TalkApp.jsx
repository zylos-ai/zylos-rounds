import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mic,
  Check,
  CalendarDays,
  CircleCheck,
  Headphones,
  History,
  Target,
  TriangleAlert,
  MessageCircle,
  Loader2,
  Link2Off,
  FlaskConical,
  RotateCw,
  Pause,
  Play,
  Keyboard,
  Send,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { TalkEngine, resolveTokenAndBase } from './engine';
import Waveform from './Waveform';

const { base: BASE, token: TOKEN } = resolveTokenAndBase();

let nextId = 1;
const nid = () => nextId++;

// "7月19日 · 星期六" from the server's report date (server TZ is authoritative)
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
function dateLabel(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  if (!m) return '';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${Number(m[2])}月${Number(m[3])}日 · 星期${WEEKDAYS[dt.getDay()]}`;
}

// Auto-reconnect backoff after an unexpected drop; then a manual retry button.
const RETRY_DELAYS = [1000, 3000, 6000];

export default function TalkApp() {
  // loading | invalid | idle | connecting | listening | speaking |
  // reconnecting | disconnected | done
  const [phase, setPhase] = useState('loading');
  const [name, setName] = useState('');
  const [isTest, setIsTest] = useState(false);
  const [task, setTask] = useState(null); // oneshot task {id,title} — null = daily standup
  const [reportDate, setReportDate] = useState('');
  const [prior, setPrior] = useState(null); // today's existing record: {status, summary}
  const [status, setStatus] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const [messages, setMessages] = useState([]);
  const [summary, setSummary] = useState(null);
  const [paused, setPaused] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);
  const engineRef = useRef(null);
  const aiIdRef = useRef(null);
  const doneRef = useRef(false);
  const reconnectRef = useRef({ attempts: 0, timer: null });
  const logRef = useRef(null);
  const summaryRef = useRef(null);

  const say = useCallback((text, err = false) => {
    setStatus(text);
    setStatusErr(err);
  }, []);

  // Load member session (token -> name); 404 -> invalid link state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/talk/session?token=${encodeURIComponent(TOKEN)}`);
        if (cancelled) return;
        if (!res.ok) {
          setPhase('invalid');
          return;
        }
        const data = await res.json();
        setName(data.name || '');
        setIsTest(Boolean(data.is_test));
        // v0.7: every link carries a task; the built-in daily keeps the
        // standup wording, so only generic tasks flip the copy below
        const generic = data.task && !data.task.is_builtin ? data.task : null;
        setTask(generic);
        document.title = `Rounds · ${generic ? generic.title : (data.name || '')}`;
        setReportDate(data.date || '');
        setPrior(data.prior || null);
        setPhase('idle');
        if (data.prior?.status === 'submitted') say('点击麦克风继续补充');
        else if (data.prior?.status === 'draft') say('点击麦克风继续，Luna 会接着刚才的聊');
        else say('点击麦克风开始');
      } catch {
        if (!cancelled) {
          setPhase('invalid');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [say]);

  useEffect(() => () => {
    clearTimeout(reconnectRef.current.timer);
    engineRef.current?.destroy();
  }, []);

  // auto-scroll chat log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  const appendAiDelta = useCallback((t) => {
    setMessages((ms) => {
      if (aiIdRef.current != null) {
        return ms.map((m) => (m.id === aiIdRef.current ? { ...m, text: m.text + t } : m));
      }
      const id = nid();
      aiIdRef.current = id;
      return [...ms, { id, role: 'ai', text: t }];
    });
  }, []);

  const startCall = useCallback(async () => {
    if (engineRef.current || doneRef.current) return;
    setPhase('connecting');
    const engine = new TalkEngine({
      base: BASE,
      token: TOKEN,
      on: {
        connecting: () => say('正在接通 Luna…'),
        ready: () => {
          if (doneRef.current) return;
          const wasReconnect = reconnectRef.current.attempts > 0;
          reconnectRef.current.attempts = 0;
          setPaused(false);
          setPhase('listening');
          say(wasReconnect ? '已重新接通，Luna 会接着刚才的继续' : 'Luna 正在跟你打招呼…');
        },
        error: (msg) => { setSubmitting(false); say(msg, true); },
        speechStarted: () => {
          if (doneRef.current || engineRef.current?.paused) return;
          setPhase('listening');
          say('在听你说…');
        },
        aiAudio: () => {
          if (doneRef.current || engineRef.current?.paused) return;
          setPhase('speaking');
          say('Luna 在说话（直接开口可打断）');
        },
        aiDelta: appendAiDelta,
        aiDone: () => {
          aiIdRef.current = null;
        },
        userPending: (itemId) => setMessages((ms) => (
          ms.some((m) => m.key === itemId) ? ms : [...ms, { id: nid(), key: itemId, role: 'me', text: '', pending: true }]
        )),
        userText: (t, itemId) => setMessages((ms) => {
          if (itemId && ms.some((m) => m.key === itemId)) {
            return t
              ? ms.map((m) => (m.key === itemId ? { ...m, text: t, pending: false } : m))
              : ms.filter((m) => m.key !== itemId);
          }
          return t ? [...ms, { id: nid(), key: itemId, role: 'me', text: t }] : ms;
        }),
        responseDone: () => {
          if (doneRef.current || engineRef.current?.paused) return;
          setPhase('listening');
          say('轮到你说了');
        },
        saved: (s) => {
          doneRef.current = true;
          setSummary(s || {});
          setPhase('done');
          say('小结已保存，Luna 道别后可直接关闭页面');
          setTimeout(() => summaryRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
        },
        closed: () => {
          setSubmitting(false);
          if (doneRef.current) return;
          const r = reconnectRef.current;
          if (r.attempts < RETRY_DELAYS.length) {
            const delay = RETRY_DELAYS[r.attempts];
            r.attempts++;
            setPhase('reconnecting');
            say(`连接断开，正在重连（第 ${r.attempts}/${RETRY_DELAYS.length} 次）…`, true);
            r.timer = setTimeout(() => engineRef.current?.reconnect(), delay);
          } else {
            setPhase('disconnected');
            say('连接断开，自动重连没成功', true);
          }
        },
      },
    });
    try {
      await engine.start();
      engineRef.current = engine;
    } catch {
      setPhase('idle');
      say('无法获取麦克风权限，请在浏览器设置里允许后刷新', true);
    }
  }, [appendAiDelta, say]);

  const togglePause = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || doneRef.current) return;
    if (engine.paused) {
      engine.resume();
      setPaused(false);
      setPhase('listening');
      say('在听你说…');
    } else {
      engine.pause();
      setPaused(true);
      setPhase('listening');
      say('已暂停，Luna 暂时听不到你');
    }
  }, [say]);

  const toggleMode = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || doneRef.current) return;
    const toText = !engine.textMode;
    try {
      await engine.setMode(toText ? 'text' : 'voice');
    } catch {
      // mic re-acquire denied — engine stays in text mode
      say('麦克风获取失败，请检查权限后重试');
      return;
    }
    setTextMode(toText);
    if (toText) {
      setPaused(false);
      setPhase('listening');
      say('文字模式，Luna 会用文字回复');
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setPhase('listening');
      say('语音模式，直接开口说话');
    }
  }, [say]);

  const sendDraft = useCallback((e) => {
    e?.preventDefault();
    const t = draft.trim();
    if (!t || !engineRef.current || doneRef.current) return;
    engineRef.current.sendText(t);
    setDraft('');
    inputRef.current?.focus();
  }, [draft]);

  const retryNow = useCallback(() => {
    reconnectRef.current.attempts = 0;
    setPhase('reconnecting');
    say('正在重连…');
    engineRef.current?.reconnect();
  }, [say]);

  const [submitting, setSubmitting] = useState(false);
  const endCall = useCallback(() => {
    if (engineRef.current && !doneRef.current) {
      setSubmitting(true);
      engineRef.current.end();
      say('正在生成小结…');
    }
  }, [say]);

  if (phase === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">加载中…</div>
    );
  }

  if (phase === 'invalid') {
    return (
      <div className="flex min-h-dvh items-center justify-center px-5">
        <Card className="w-full max-w-[420px]">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Link2Off className="h-6 w-6" strokeWidth={1.75} />
            </div>
            <div className="text-xl font-bold tracking-tight">链接无效</div>
            <p className="max-w-[300px] text-[0.95rem] leading-relaxed text-muted-foreground">
              这个专属链接不存在或已失效，请联系管理员获取新的专属链接。
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const inCall = phase === 'listening' || phase === 'speaking';
  // Hero (centered welcome) until the call is actually underway, then the
  // top-anchored conversation layout takes over.
  const started = inCall || phase === 'done' || messages.length > 0 || !!summary;

  const orb = (
    <button
      type="button"
      aria-label="开始对话"
      disabled={phase !== 'idle'}
      onClick={startCall}
      className={cn(
        'orb',
        phase === 'listening' && 'listening',
        phase === 'speaking' && 'speaking',
        phase === 'done' && 'done'
      )}
    >
      {phase === 'done' ? (
        <Check className="h-[38px] w-[38px]" strokeWidth={1.6} />
      ) : phase === 'connecting' || phase === 'reconnecting' ? (
        <Loader2 className="h-[38px] w-[38px] animate-spin" strokeWidth={1.6} />
      ) : (
        <Mic className="h-[38px] w-[38px]" strokeWidth={1.6} />
      )}
    </button>
  );

  const statusLine = (
    <div
      className={cn(
        'min-h-[1.3em] text-center text-[0.95rem]',
        statusErr ? 'text-destructive' : 'text-muted-foreground'
      )}
      role="status"
    >
      {status}
    </div>
  );

  const submittedToday = prior?.status === 'submitted';
  const draftToday = prior?.status === 'draft';

  if (!started) {
    return (
      <div
        className={cn(
          'flex min-h-dvh flex-col items-center px-5 pb-[calc(24px+env(safe-area-inset-bottom))]',
          submittedToday ? 'justify-start pt-10' : 'justify-center'
        )}
      >
        <div className="flex w-full max-w-[640px] flex-col items-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Mic className="h-6 w-6" strokeWidth={2} />
          </span>
          <div className="mt-6 text-[0.82rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Rounds
          </div>
          {reportDate ? (
            <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-primary-line bg-primary-soft px-3.5 py-1 text-[0.92rem] font-semibold text-primary">
              <CalendarDays className="h-4 w-4" strokeWidth={1.75} />
              今天 {dateLabel(reportDate)}
            </div>
          ) : null}
          <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight max-sm:text-3xl">
            {submittedToday
              ? (task ? `${name}，「${task.title}」已提交` : `${name}，今天的日报已提交`)
              : draftToday
                ? `${name}，上次聊到一半`
                : task ? `${name}，聊聊「${task.title}」` : `${name}，和 Luna 聊 3-5 分钟`}
          </h1>
          <p className="mt-4 text-[1.05rem] leading-relaxed text-muted-foreground max-sm:text-base">
            {submittedToday
              ? '想到新内容可以继续补充，Luna 会把补充合并进小结'
              : draftToday
                ? 'Luna 会接着刚才聊到的地方继续'
                : task ? 'Luna 代表负责人和你做一次一对一沟通，想到什么说什么' : '昨天做了什么 · 今天计划 · 卡点 · 想在日会讨论的问题'}
          </p>
          {submittedToday && prior.summary ? (
            <Card className="mt-7 w-full max-w-[460px] text-left">
              <CardContent className="py-5">
                <div className="flex items-center gap-2 text-[1.02rem] font-bold tracking-tight text-success">
                  <CircleCheck className="h-[18px] w-[18px]" strokeWidth={1.75} />
                  {task ? '已提交的小结' : '今天已提交的日报'}
                </div>
                {task ? (
                  <>
                    <SummarySection icon={Target} title="小结" items={prior.summary.summary} />
                    <SummarySection icon={MessageCircle} title="要点" items={prior.summary.highlights} />
                  </>
                ) : (
                  <>
                    <SummarySection icon={History} title="昨天" items={prior.summary.yesterday} />
                    <SummarySection icon={Target} title="今天" items={prior.summary.today} />
                    <SummarySection icon={TriangleAlert} title="卡点" items={prior.summary.blockers} />
                    <SummarySection icon={MessageCircle} title="日会待议" items={prior.summary.topics_for_meeting} />
                  </>
                )}
              </CardContent>
            </Card>
          ) : null}
          {isTest ? (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[0.85rem] text-faint">
              <FlaskConical className="h-4 w-4" strokeWidth={1.75} />
              体验模式 · 内容不计入正式汇报
            </p>
          ) : null}
          <p className="mt-2 inline-flex items-center gap-1.5 text-[0.85rem] text-faint">
            <Headphones className="h-4 w-4" strokeWidth={1.75} />
            建议戴耳机，回声更少、听得更清
          </p>
          <div className="mt-12 max-sm:mt-10">{orb}</div>
          <div className="mt-5">{statusLine}</div>
          {phase === 'disconnected' && (
            <Button variant="secondary" className="mt-3" onClick={retryNow}>
              <RotateCw strokeWidth={1.75} />
              重新连接
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[640px] flex-col overflow-hidden px-5 pb-[calc(16px+env(safe-area-inset-bottom))]">
      <header className="flex shrink-0 items-center gap-2.5 pb-2 pt-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Mic className="h-[18px] w-[18px]" strokeWidth={2} />
        </span>
        <div className="leading-tight">
          <div className="text-[1.02rem] font-bold tracking-tight">Rounds</div>
          {name ? (
            <div className="flex items-center gap-1.5 text-[0.78rem] text-muted-foreground">
              {name}
              {reportDate ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary-line bg-primary-soft px-2 py-px text-[0.7rem] font-medium text-primary">
                  <CalendarDays className="h-3 w-3" strokeWidth={1.75} />
                  {dateLabel(reportDate)}
                </span>
              ) : null}
              {task ? (
                <span className="inline-flex items-center rounded-full bg-accent px-2 py-px text-[0.7rem] font-medium">
                  {task.title}
                </span>
              ) : null}
              {isTest ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-px text-[0.7rem] font-medium">
                  <FlaskConical className="h-3 w-3" strokeWidth={1.75} />
                  体验模式
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {/* stage — fixed; only the chat log below scrolls */}
      <div className="flex shrink-0 flex-col items-center pb-1.5 pt-4">
        <div className={cn((paused || textMode) && 'opacity-60')}>{orb}</div>

        <div className={cn('mt-3 flex h-9 items-center justify-center', (!inCall || paused || textMode) && 'invisible')}>
          <Waveform analyser={engineRef.current?.analyser} active={inCall && !paused && !textMode} />
        </div>

        {statusLine}

        {/* control row — one secondary button family under the orb */}
        <div className="mt-2.5 flex items-center justify-center gap-2">
          {inCall && (
            <>
              <Button variant="secondary" onClick={toggleMode} disabled={submitting}>
                {textMode ? <Mic strokeWidth={1.75} /> : <Keyboard strokeWidth={1.75} />}
                {textMode ? '语音' : '文字'}
              </Button>
              {!textMode && (
                <Button variant="secondary" onClick={togglePause} disabled={submitting}>
                  {paused ? <Play strokeWidth={1.75} /> : <Pause strokeWidth={1.75} />}
                  {paused ? '继续' : '暂停'}
                </Button>
              )}
              <Button variant="secondary" onClick={endCall} disabled={submitting}>
                {submitting ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : <Check strokeWidth={1.75} />}
                {submitting ? '正在生成小结…' : '结束并提交'}
              </Button>
            </>
          )}
          {phase === 'reconnecting' && (
            <Button variant="secondary" disabled>
              <Loader2 className="animate-spin" strokeWidth={1.75} />
              正在重连…
            </Button>
          )}
          {phase === 'disconnected' && (
            <Button variant="secondary" onClick={retryNow}>
              <RotateCw strokeWidth={1.75} />
              重新连接
            </Button>
          )}
        </div>
      </div>

      {/* chat log — the page's only scroll region; the stage above stays put */}
      <div ref={logRef} className="mt-4 min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-2 pb-2">
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                'max-w-[86%] whitespace-pre-wrap rounded-lg border px-3.5 py-2.5 text-[0.92rem] leading-relaxed',
                m.role === 'ai'
                  ? 'self-start border-border-strong bg-card shadow-xs'
                  : 'self-end border-primary-line bg-primary-soft',
                m.pending && 'text-muted-foreground'
              )}
            >
              {m.text || (m.pending ? '…' : '')}
            </div>
          ))}
        </div>

        {/* submitted summary — lives inside the scroll region */}
        {summary && (
        <div ref={summaryRef} className="mb-1.5 mt-3.5">
          <Card>
            <CardContent className="py-5">
              <div className="flex items-center gap-2 text-[1.05rem] font-bold tracking-tight text-success">
                <CircleCheck className="h-[18px] w-[18px]" strokeWidth={1.75} />
                日报已提交
              </div>
              <SummarySection icon={History} title="昨天" items={summary.yesterday} />
              <SummarySection icon={Target} title="今天" items={summary.today} />
              <SummarySection icon={TriangleAlert} title="卡点" items={summary.blockers} />
              <SummarySection icon={MessageCircle} title="日会待议" items={summary.topics_for_meeting} />
            </CardContent>
          </Card>
        </div>
        )}
      </div>

      {/* text-mode composer — pinned under the scroll region */}
      {textMode && inCall && (
        <form className="mt-2 flex shrink-0 items-center gap-2 pb-1" onSubmit={sendDraft}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="输入消息，回车发送…"
            className="h-[38px] min-w-0 flex-1 rounded-md border border-border-strong bg-card px-3 text-[0.92rem] shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" size="icon" className="h-[38px] w-[38px]" disabled={!draft.trim() || submitting} aria-label="发送">
            <Send strokeWidth={1.75} />
          </Button>
        </form>
      )}
    </div>
  );
}

function SummarySection({ icon: Icon, title, items }) {
  return (
    <>
      <h3 className="mb-1 mt-3.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        {title}
      </h3>
      <ul className="list-disc pl-5 text-[0.88rem] leading-relaxed">
        {items && items.length ? (
          items.map((x, i) => <li key={i}>{x}</li>)
        ) : (
          <li className="text-faint">（无）</li>
        )}
      </ul>
    </>
  );
}

function Shell({ name, task, children }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-5 pb-[calc(16px+env(safe-area-inset-bottom))]">
      <header className="pb-1 pt-[18px]">
        <h1 className="flex items-center gap-2 text-[1.05rem] font-semibold">
          <Mic className="h-[18px] w-[18px] text-primary" strokeWidth={1.75} />
          Rounds
        </h1>
        {name ? (
          <p className="mt-1.5 text-[0.82rem] leading-normal text-muted-foreground">
            {task ? `${name}，正在聊「${task.title}」——Luna 代表负责人和你做一次一对一沟通。` : `${name}，和 Luna 聊 3-5 分钟：昨天做了什么 · 今天计划 · 卡点 · 想在日会讨论的问题。`}
          </p>
        ) : null}
        {name ? (
          <p className="mt-1 inline-flex items-center gap-1.5 text-[0.78rem] text-faint">
            <Headphones className="h-3.5 w-3.5" strokeWidth={1.75} />
            建议戴耳机，回声更少、听得更清
          </p>
        ) : null}
      </header>
      {children}
    </div>
  );
}
