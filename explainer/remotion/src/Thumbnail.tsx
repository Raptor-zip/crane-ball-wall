import React from 'react';
import {AbsoluteFill, Img, staticFile} from 'remotion';

const FONT = '"Noto Sans CJK JP", "Noto Sans JP", sans-serif';

// background: a frame of the s01 clip (explainer/build.sh extracts it to public/thumb_bg.png)
export const Thumbnail: React.FC = () => (
	<AbsoluteFill style={{background: '#101318'}}>
		<Img src={staticFile('thumb_bg.png')} style={{width: '100%', height: '100%', objectFit: 'cover', opacity: 0.9}} />
		<AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(16,19,24,0.92) 0%, rgba(16,19,24,0.35) 55%, rgba(16,19,24,0) 100%)'}} />
		<div style={{position: 'absolute', top: 56, left: 70, right: 70, fontFamily: FONT}}>
			<div style={{color: '#f5f3ef', fontSize: 104, fontWeight: 900, lineHeight: 1.12, letterSpacing: '-0.01em'}}>
				台車を押すだけで
				<br />
				<span style={{color: '#f59e0b'}}>すき間に入れて止める</span>
			</div>
			<div style={{marginTop: 26, color: '#cbd5e1', fontSize: 46, fontWeight: 700}}>
				運動方程式 → 軌道最適化 → 時変LQR
			</div>
		</div>
	</AbsoluteFill>
);
