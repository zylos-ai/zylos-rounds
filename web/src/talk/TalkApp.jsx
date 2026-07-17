import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mic,
  Check,
  CircleCheck,
  Headphones,
  History,
  Target,
  TriangleAlert,
  MessageCircle,
  Loader2,
  Link2Off,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { TalkEngine, resolveTokenAndBase } from './engine';
import Waveform from './Waveform';

const { base: BASE, token: TOKEN } = resolveTokenAndBase();

let nextId = 1;
const nid = () => nextId++;

export default function TalkApp() {
  // loading | invalid | idle | connecting | listening | speaking | done
  const [phase, setPhase] = useState('loading');
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const [messages, setMessages] = useState([]);
  const [summary, setSummary] = useState(null);
  const engineRef = useRef(null);
  const aiIdRef = useRef(null);
  const doneRef = useRef(false);
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
        document.title = `语音日报 · ${data.name || ''}`;
        setPhase('idle');
        say('点击麦克风开始');
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

  useEffect(() => () => engineRef.current?.destroy(), []);

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
          setPhase('listening');
          say('Luna 正在跟你打招呼…');
        },
        error: (msg) => say(msg, true),
        speechStarted: () => {
          if (doneRef.current) return;
          setPhase('listening');
          say('在听你说…');
        },
        aiAudio: () => {
          if (doneRef.current) return;
          setPhase('speaking');
          say('Luna 在说话（直接开口可打断）');
        },
        aiDelta: appendAiDelta,
        aiDone: () => {
          aiIdRef.current = null;
        },
        userText: (t) => setMessages((ms) => [...ms, { id: nid(), role: 'me', text: t }]),
        responseDone: () => {
          if (doneRef.current) return;
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
        closed: () => { setSubmitting(false); say('连接已断开，刷新页面可重试', true); },
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
      <Shell>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">加载中…</div>
      </Shell>
    );
  }

  if (phase === 'invalid') {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center px-2">
          <Card className="w-full">
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Link2Off className="h-5 w-5" strokeWidth={1.75} />
              </div>
              <div className="text-base font-semibold">链接无效</div>
              <p className="max-w-[300px] text-sm leading-relaxed text-muted-foreground">
                这个专属链接不存在或已失效，请联系管理员获取新的语音日报链接。
              </p>
            </CardContent>
          </Card>
        </div>
      </Shell>
    );
  }

  const inCall = phase === 'listening' || phase === 'speaking';

  return (
    <Shell name={name}>
      {/* stage */}
      <div className="flex flex-col items-center pb-1.5 pt-5">
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
            <Check className="h-[34px] w-[34px]" strokeWidth={1.6} />
          ) : phase === 'connecting' ? (
            <Loader2 className="h-[34px] w-[34px] animate-spin" strokeWidth={1.6} />
          ) : (
            <Mic className="h-[34px] w-[34px]" strokeWidth={1.6} />
          )}
        </button>

        <div className={cn('mt-3 flex h-9 items-center justify-center', !inCall && 'invisible')}>
          <Waveform analyser={engineRef.current?.analyser} active={inCall} />
        </div>

        <div
          className={cn('min-h-[1.3em] text-center text-[0.83rem]', statusErr ? 'text-destructive' : 'text-muted-foreground')}
          role="status"
        >
          {status}
        </div>

        {inCall && (
          <Button variant="secondary" className="mt-2.5" onClick={endCall} disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : <Check strokeWidth={1.75} />}
            {submitting ? '正在生成小结…' : '结束并提交'}
          </Button>
        )}
      </div>

      {/* chat log */}
      <div ref={logRef} className="mt-4 flex flex-1 flex-col gap-2 overflow-y-auto pb-2">
        {messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              'max-w-[86%] whitespace-pre-wrap rounded-lg border px-3 py-2 text-[0.9rem] leading-normal',
              m.role === 'ai'
                ? 'self-start border-border-strong bg-card shadow-xs'
                : 'self-end border-primary-line bg-primary-soft'
            )}
          >
            {m.text}
          </div>
        ))}
      </div>

      {/* submitted summary */}
      {summary && (
        <div ref={summaryRef} className="mb-1.5 mt-3.5">
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-2 text-[0.95rem] font-semibold text-success">
                <CircleCheck className="h-4 w-4" strokeWidth={1.75} />
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
    </Shell>
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

function Shell({ name, children }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-5 pb-[calc(16px+env(safe-area-inset-bottom))]">
      <header className="pb-1 pt-[18px]">
        <h1 className="flex items-center gap-2 text-[1.05rem] font-semibold">
          <Mic className="h-[18px] w-[18px] text-primary" strokeWidth={1.75} />
          语音日报
        </h1>
        {name ? (
          <p className="mt-1.5 text-[0.82rem] leading-normal text-muted-foreground">
            {name}，和 Luna 聊 3-5 分钟：昨天做了什么 · 今天计划 · 卡点 · 想在日会讨论的问题。
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
