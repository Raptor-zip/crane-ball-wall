// X promo of 「ゆらしてピタッ」: 9:16, narration by ずんだもん (promo/tts.py -> public/timeline.json), gameplay clips
// recorded from the game itself (promo/capture/capture.mjs -> public/clips/).
import type {CSSProperties} from 'react';
import {AbsoluteFill, Audio, Easing, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {FONT} from './fonts';

export const FPS = 30;
export type Line = {text: string; file: string; start: number; end: number};
export type Scene = {id: string; start: number; duration: number; lines: Line[]};

const C = {paper: '#f3eee4', grid: '#e1d8c8', ink: '#1e2a44', card: '#fbf8f1', gantry: '#f2b705', stamp: '#d8342b', ai: '#19c3ff', goal: '#22b573'};
const URL_TEXT = 'yurapita.raptor-s.workers.dev';

/** Footage per scene: clip, start [s] in the clip, finger overlay, headline. */
const SHOTS: Record<string, {clip: string; from: number; fingers?: string; head: string[]; accent?: string}> = {
  hook: {clip: 'title', from: 0.4, head: ['壁の向こうに', 'ピタッと置け'], accent: C.stamp},
  crash: {clip: 'crash12', from: 0.45, fingers: 'crash12', head: ['勢いまかせは…'], accent: C.stamp},
  play: {clip: 'play14', from: 0.1, fingers: 'play14', head: ['引いて・振って・離す']},
  ai: {clip: 'ai22', from: 1.0, head: ['ライバルは', '最適制御AI'], accent: C.ai},
  result: {clip: 'play14', from: 6.2, head: ['AIとの差、', '何秒？']},
};

const CARD = {w: 800, h: 1422, top: 258}; // the 1080x1920 clip at 0.741
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

export const Promo = ({timeline}: {timeline: Scene[]}) => (
  <AbsoluteFill style={{background: C.paper, fontFamily: FONT, color: C.ink}}>
    <Grid />
    {timeline.map((sc) => (
      <Sequence key={sc.id} from={Math.round(sc.start * FPS)} durationInFrames={Math.round(sc.duration * FPS)}>
        {sc.id === 'cta' ? <EndCard /> : <Shot id={sc.id} />}
        <Subtitles lines={sc.lines} />
        {sc.lines.map((l) => (
          <Sequence key={l.file} from={Math.round(l.start * FPS)}>
            <Audio src={staticFile(l.file)} />
          </Sequence>
        ))}
      </Sequence>
    ))}
  </AbsoluteFill>
);

const Grid = () => (
  <AbsoluteFill
    style={{
      backgroundImage: `linear-gradient(${C.grid} 2px, transparent 2px), linear-gradient(90deg, ${C.grid} 2px, transparent 2px)`,
      backgroundSize: '60px 60px',
      opacity: 0.7,
    }}
  />
);

const Shot = ({id}: {id: string}) => {
  const f = useCurrentFrame();
  const shot = SHOTS[id]!;
  const pop = interpolate(f, [0, 7], [0.94, 1], {...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1)});
  return (
    <AbsoluteFill>
      <Headline lines={shot.head} accent={shot.accent} />
      <div style={{position: 'absolute', left: (1080 - CARD.w) / 2, top: CARD.top, width: CARD.w, height: CARD.h, transform: `scale(${pop})`}}>
        <div style={{position: 'absolute', inset: 0, borderRadius: 40, border: `7px solid ${C.ink}`, boxShadow: `0 12px 0 ${C.ink}`, overflow: 'hidden', background: C.card}}>
          <OffthreadVideo src={staticFile(`clips/${shot.clip}.mp4`)} startFrom={Math.round(shot.from * FPS)} muted style={{width: '100%', height: '100%'}} />
          {shot.fingers ? <Finger file={shot.fingers} from={shot.from} /> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Headline = ({lines, accent}: {lines: string[]; accent?: string}) => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: f, fps, config: {damping: 14, stiffness: 160, mass: 0.7}});
  const size = lines.length > 1 ? 88 : 96;
  return (
    <div style={{position: 'absolute', top: 38, left: 0, right: 0, height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', transform: `translateY(${(1 - s) * -30}px)`, opacity: s}}>
      {lines.map((t, i) => (
        <div key={t} style={{fontSize: size, fontWeight: 900, lineHeight: 1.08, whiteSpace: 'nowrap', letterSpacing: '0.02em', color: i === lines.length - 1 && accent ? accent : C.ink, WebkitTextStroke: `3px ${C.card}`, paintOrder: 'stroke'}}>
          {t}
        </div>
      ))}
    </div>
  );
};

const Subtitles = ({lines}: {lines: Line[]}) => {
  const f = useCurrentFrame();
  const t = f / FPS;
  const cur = [...lines].reverse().find((l) => t >= l.start - 0.05);
  if (!cur) return null;
  const style: CSSProperties = {
    position: 'absolute', left: 50, right: 50, top: CARD.top + CARD.h + 34, height: 170, display: 'flex', alignItems: 'center', justifyContent: 'center',
    textAlign: 'center', fontSize: 50, fontWeight: 800, lineHeight: 1.3, color: C.card, background: C.ink, borderRadius: 28, padding: '0 34px',
  };
  return (
    <div style={style}>
      <span style={{whiteSpace: 'pre-line'}}>{cur.text}</span>
    </div>
  );
};

type Touch = {ms: number; x: number; y: number; down: boolean};

/** A fingertip where the recorded drag touched the deck (CSS px of the 432x768 game viewport). */
const Finger = ({file, from}: {file: string; from: number}) => {
  const f = useCurrentFrame();
  const pts = FINGERS[file] ?? [];
  const ms = (from + f / FPS) * 1000;
  let i = -1;
  for (let k = 0; k < pts.length; k++) if (pts[k]!.ms <= ms) i = k;
  if (i < 0) return null;
  const p = pts[i]!;
  const upAge = p.down ? 0 : ms - p.ms;
  const alpha = p.down ? 1 : interpolate(upAge, [0, 300], [1, 0], clamp);
  if (alpha <= 0) return null;
  const k = CARD.w / 432;
  const trail = pts.slice(Math.max(0, i - 8), i + 1).filter((q) => q.down);
  return (
    <>
      {trail.map((q, j) => (
        <div key={q.ms} style={{position: 'absolute', left: q.x * k - 22, top: q.y * k - 22, width: 44, height: 44, borderRadius: 22, background: C.gantry, opacity: (0.25 * (j + 1)) / trail.length * alpha}} />
      ))}
      <div style={{position: 'absolute', left: p.x * k - 46, top: p.y * k - 46, width: 92, height: 92, borderRadius: 46, background: 'rgba(242,183,5,0.45)', border: `6px solid ${C.card}`, boxShadow: `0 0 0 4px ${C.ink}`, opacity: alpha}} />
    </>
  );
};

import play14 from '../public/clips/play14.json';
import crash12 from '../public/clips/crash12.json';
const FINGERS: Record<string, Touch[]> = {play14: play14 as Touch[], crash12: crash12 as Touch[]};

const EndCard = () => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const a = spring({frame: f, fps, config: {damping: 13, stiffness: 150, mass: 0.8}});
  const b = spring({frame: f - 8, fps, config: {damping: 15, stiffness: 140}});
  const c = spring({frame: f - 16, fps, config: {damping: 15, stiffness: 140}});
  return (
    <AbsoluteFill style={{alignItems: 'center'}}>
      <div style={{marginTop: 120, transform: `scale(${0.8 + 0.2 * a})`, opacity: a, textAlign: 'center'}}>
        <div style={{fontSize: 150, fontWeight: 900, lineHeight: 1, whiteSpace: 'nowrap'}}>
          ゆらして<span style={{color: C.stamp}}>ピタッ</span>
        </div>
        <div style={{height: 14, width: 470, background: C.ink, borderRadius: 7, margin: '18px 0 0 auto', transform: 'rotate(-2deg)'}} />
      </div>
      <div style={{marginTop: 46, fontSize: 52, fontWeight: 800, padding: '16px 40px', border: `5px solid ${C.ink}`, borderRadius: 60, background: C.card, opacity: b, transform: `translateY(${(1 - b) * 30}px)`}}>
        最適制御AIに、人間の指で勝て。
      </div>
      <div style={{marginTop: 50, width: 800, height: 620, borderRadius: 40, border: `7px solid ${C.ink}`, boxShadow: `0 12px 0 ${C.ink}`, overflow: 'hidden', opacity: b}}>
        <OffthreadVideo src={staticFile('clips/title.mp4')} startFrom={0} muted style={{width: '100%', marginTop: -310}} />
      </div>
      <div style={{marginTop: 64, textAlign: 'center', opacity: c, transform: `translateY(${(1 - c) * 30}px)`}}>
        <div style={{fontSize: 44, fontWeight: 800}}>スマホ・パソコンのブラウザで今すぐ無料</div>
        <div style={{marginTop: 22, fontSize: 54, fontWeight: 900, color: C.card, background: C.stamp, borderRadius: 24, padding: '20px 40px', border: `5px solid ${C.ink}`, boxShadow: `0 8px 0 ${C.ink}`, whiteSpace: 'nowrap'}}>
          {URL_TEXT}
        </div>
      </div>
    </AbsoluteFill>
  );
};
