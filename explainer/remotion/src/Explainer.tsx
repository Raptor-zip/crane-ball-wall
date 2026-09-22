import React from 'react';
import {
	AbsoluteFill,
	Audio,
	OffthreadVideo,
	Sequence,
	interpolate,
	spring,
	staticFile,
	useCurrentFrame,
	useVideoConfig,
} from 'remotion';
import timeline from '../public/timeline.json';

// timeline.json is written by explainer/tts.py; the Manim clips are paced on it.
export type Line = {text: string; file: string; start: number; end: number};
export type Scene = {id: string; chapter: string; start: number; duration: number; lines: Line[]};

export const FPS = 30;
export const SCENES = timeline as Scene[];

const C = {
	bg: '#101318',
	text: '#f5f3ef',
	muted: '#8b929c',
	accent: '#f59e0b',
	panel: 'rgba(16,19,24,0.82)',
};
const FONT = '"Noto Sans CJK JP", "Noto Sans JP", sans-serif';

// frame layout: each scene gets whole frames; cumulative rounding keeps audio on time
export const layout = (() => {
	let from = 0;
	return SCENES.map((s) => {
		const frames = Math.ceil(s.duration * FPS);
		const out = {...s, from, frames};
		from += frames;
		return out;
	});
})();
export const TOTAL_FRAMES = layout.reduce((a, s) => a + s.frames, 0);

const chapters = (() => {
	const out: {name: string; from: number}[] = [];
	for (const s of layout) {
		if (!out.length || out[out.length - 1].name !== s.chapter) out.push({name: s.chapter, from: s.from});
	}
	return out;
})();

const Subtitle: React.FC<{text: string; frames: number}> = ({text, frames}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const pop = spring({frame, fps, config: {damping: 14, stiffness: 220, mass: 0.6}});
	const out = interpolate(frame, [frames - 4, frames], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
	return (
		<AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 44}}>
			<div
				style={{
					maxWidth: 1800,
					padding: '12px 36px',
					borderRadius: 18,
					background: C.panel,
					color: C.text,
					fontFamily: FONT,
					fontWeight: 700,
					fontSize: 46,
					lineHeight: 1.36,
					textAlign: 'center',
					letterSpacing: '0.02em',
					// rows are broken by hand in script.py: never wrap inside a phrase
					whiteSpace: 'pre',
					opacity: out,
					transform: `translateY(${(1 - pop) * 18}px) scale(${0.96 + 0.04 * pop})`,
				}}
			>
				{text}
			</div>
		</AbsoluteFill>
	);
};

const ChapterTag: React.FC<{index: number; name: string}> = ({index, name}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const s = spring({frame, fps, config: {damping: 16, stiffness: 180}});
	return (
		<div
			style={{
				position: 'absolute',
				top: 30,
				left: 36,
				display: 'flex',
				alignItems: 'center',
				gap: 14,
				fontFamily: FONT,
				transform: `translateX(${(1 - s) * -40}px)`,
				opacity: s,
			}}
		>
			<div
				style={{
					background: C.accent,
					color: C.bg,
					fontWeight: 800,
					fontSize: 26,
					borderRadius: 10,
					padding: '4px 14px',
				}}
			>
				{String(index + 1).padStart(2, '0')}
			</div>
			<div style={{color: C.muted, fontSize: 28, fontWeight: 700}}>{name}</div>
		</div>
	);
};

const Progress: React.FC = () => {
	const frame = useCurrentFrame();
	const {width} = useVideoConfig();
	return (
		<AbsoluteFill style={{justifyContent: 'flex-end'}}>
			<div style={{position: 'relative', height: 8, background: 'rgba(255,255,255,0.08)'}}>
				<div style={{height: 8, width: (frame / TOTAL_FRAMES) * width, background: C.accent}} />
				{chapters.slice(1).map((c) => (
					<div
						key={c.from}
						style={{position: 'absolute', top: 0, left: (c.from / TOTAL_FRAMES) * width - 2, width: 4, height: 8, background: C.bg}}
					/>
				))}
			</div>
		</AbsoluteFill>
	);
};

export const Explainer: React.FC = () => {
	return (
		<AbsoluteFill style={{background: C.bg}}>
			{layout.map((s) => (
				<Sequence key={s.id} from={s.from} durationInFrames={s.frames} name={s.id}>
					<OffthreadVideo src={staticFile(`manim/${s.id}.mp4`)} muted />
					{s.lines.map((ln, i) => {
						const from = Math.round(ln.start * FPS);
						const next = s.lines[i + 1];
						// keep the subtitle up through the pause that follows the line
						const until = next ? Math.round(next.start * FPS) : s.frames;
						return (
							<Sequence key={ln.file} from={from} durationInFrames={Math.max(1, until - from)} name={`line ${i}`}>
								<Audio src={staticFile(ln.file)} />
								<Subtitle text={ln.text} frames={until - from} />
							</Sequence>
						);
					})}
				</Sequence>
			))}
			{chapters.map((c, i) => (
				<Sequence
					key={c.from}
					from={c.from}
					durationInFrames={(chapters[i + 1]?.from ?? TOTAL_FRAMES) - c.from}
					name={`chapter ${c.name}`}
				>
					<ChapterTag index={i} name={c.name} />
				</Sequence>
			))}
			<Progress />
		</AbsoluteFill>
	);
};
