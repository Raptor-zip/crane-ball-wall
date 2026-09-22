"""Manim scenes of the explainer video, one per narration scene (explainer/script.py).

Render one:   uv run manim -ql explainer/manim/scenes.py S03Lagrange
Render all:   uv run python explainer/render.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from manim import *  # noqa: F401,F403

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *  # noqa: E402,F401,F403


def eq_rows(rows, size=40, buff=0.32):
    g = VGroup(*[tex(r, size) if isinstance(r, str) else r for r in rows])
    return g.arrange(DOWN, buff=buff, aligned_edge=LEFT)


def headline(s, size=40):
    return jp(s, size, weight="BOLD").to_edge(UP, buff=0.85)


def plot_axes(x_range, y_range, w, h, xlabel="", ylabel="", tips=False):
    ax = Axes(x_range=x_range, y_range=y_range, x_length=w, y_length=h, tips=tips,
              axis_config={"color": MUTED, "stroke_width": 2, "include_ticks": True, "font_size": 22},
              x_axis_config={"numbers_to_include": np.arange(x_range[0], x_range[1] + 1e-9, x_range[2])},
              y_axis_config={"numbers_to_include": np.arange(y_range[0], y_range[1] + 1e-9, y_range[2])})
    labs = VGroup()
    if xlabel:
        labs.add(jp(xlabel, 20, MUTED).next_to(ax.x_axis, DOWN, buff=0.35).align_to(ax.x_axis, RIGHT))
    if ylabel:
        labs.add(jp(ylabel, 20, MUTED).next_to(ax.y_axis, UP, buff=0.12).align_to(ax.y_axis, LEFT))
    return ax, labs


def curve(ax, t, y, color, width=3):
    m = VMobject(stroke_color=color, stroke_width=width)
    m.set_points_as_corners([ax.c2p(a, b) for a, b in zip(t, y)])
    return m


def steps(ax, t, u, color, width=2.5):
    pts = []
    for k in range(len(u)):
        pts += [ax.c2p(t[k], u[k]), ax.c2p(t[k + 1], u[k])]
    m = VMobject(stroke_color=color, stroke_width=width)
    m.set_points_as_corners(pts)
    return m


# --------------------------------------------------------------------------- 1
class S01Intro(NarratedScene):
    sid = "s01_intro"

    def construct(self):
        tr = traj("enter", "fast")
        cr = Crane(k=2.7, at=DOWN * 2.05 + RIGHT * 0.2)
        cr.set_state(tr["x"][0], tr["theta"][0])
        q = jp("台車を押すだけで、ボールをすき間に入れて止められる？", 36, weight="BOLD").to_edge(UP, buff=0.9)
        self.play(FadeIn(cr, shift=UP * 0.2), Write(q), run_time=1.6)

        self.cue(1)
        w0, w1 = cr.walls
        gap = BraceBetweenPoints(cr.w2s(1.42, 0.8), cr.w2s(1.84, 0.8), UP, color=FORCE)
        gl = jp("42 cm", 28, FORCE).next_to(gap, UP, buff=0.1)
        dia = BraceBetweenPoints(cr.ball.get_left(), cr.ball.get_right(), DOWN, color=BALL)
        dl = jp("12 cm", 24, BALL).next_to(dia, DOWN, buff=0.08)
        self.play(GrowFromCenter(gap), FadeIn(gl), GrowFromCenter(dia), FadeIn(dl), run_time=1.0)

        self.cue(2)
        self.play(FadeOut(VGroup(gap, gl, dia, dl)), run_time=0.4)
        vt = cr.player(tr["t"], tr["x"], tr["theta"])
        path = cr.trace(BALL, 3, 0.7)
        self.add(path)
        t_show = min(tr["t"][-1], tr["t_plan"] + 0.6)
        self.play(vt.animate.set_value(t_show), run_time=min(t_show, self.until(3)), rate_func=linear)
        cr.clear_updaters()

        self.cue(3)
        title = VGroup(jp("クレーンで壁のすき間にボールを入れる", 50, weight="BOLD"),
                       jp("運動方程式の立式から、軌道最適化・時変LQRまで", 30, MUTED)).arrange(DOWN, buff=0.25)
        title.to_edge(UP, buff=0.8)
        self.play(ReplacementTransform(q, title), run_time=1.0)

        self.cue(4)
        tools = VGroup(*[card(VGroup(jp(a, 26, c, weight="BOLD"), jp(b, 20, MUTED)).arrange(DOWN, buff=0.12))
                         for a, b, c in (("① ラグランジュ", "運動方程式を立てる", ANGLE),
                                         ("② 軌道最適化", "どう押すかを決める", FORCE),
                                         ("③ 時変LQR", "ずれを直して追いかける", OK))]).arrange(RIGHT, buff=0.5)
        tools.next_to(title, DOWN, buff=0.45)
        self.play(FadeOut(path), cr.animate.set_opacity(0.35), run_time=0.5)
        for i, c in enumerate(tools):
            self.play(FadeIn(c, shift=UP * 0.2), run_time=0.45)
            self.hold(self.span(4) / 4 - 0.45 if i < 2 else 0)
        self.finish()


# --------------------------------------------------------------------------- 2
class S02Setup(NarratedScene):
    sid = "s02_setup"

    def construct(self):
        cr = Crane(k=3.0, at=DOWN * 2.1 + RIGHT * 0.1)
        cr.set_state(0.0, 0.0)
        self.play(FadeIn(cr.scenery), run_time=0.6)
        self.play(FadeIn(cr.trolley, shift=DOWN * 0.2), run_time=0.5)
        Ml = jp("台車  M = 2 kg", 26, TROLLEY).next_to(cr.trolley, UP, buff=0.25)
        self.play(FadeIn(Ml), run_time=0.4)

        self.cue(1)
        self.play(Create(cr.string), FadeIn(cr.ball, scale=0.5), run_time=0.8)
        Lb = BraceBetweenPoints(cr.pivot(), cr.ball.get_center(), LEFT, color=STRING)
        Ll = jp("紐  L = 1 m", 24, STRING).next_to(Lb, LEFT, buff=0.1)
        ml = jp("ボール  m = 1 kg", 24, BALL).next_to(cr.ball, RIGHT, buff=0.2)
        self.play(GrowFromCenter(Lb), FadeIn(Ll), FadeIn(ml), run_time=0.8)

        self.cue(2)
        hb = BraceBetweenPoints(cr.w2s(1.96, 0), cr.w2s(1.96, 0.75), RIGHT, color=BRICK)
        hl = jp("0.75 m", 24, BRICK).next_to(hb, RIGHT, buff=0.1)
        gb = BraceBetweenPoints(cr.w2s(1.42, 0.78), cr.w2s(1.84, 0.78), UP, color=FORCE)
        gl = jp("すき間 0.42 m", 24, FORCE).next_to(gb, UP, buff=0.08)
        self.play(Indicate(cr.walls, color=BRICK, scale_factor=1.05), GrowFromCenter(hb), FadeIn(hl), run_time=1.0)
        self.play(GrowFromCenter(gb), FadeIn(gl), run_time=0.6)

        self.cue(3)
        arrow = Arrow(cr.trolley.get_left() + LEFT * 1.3, cr.trolley.get_left(), buff=0.05, color=FORCE,
                      stroke_width=8, max_tip_length_to_length_ratio=0.3)
        Fl = tex("F", 44, FORCE).next_to(arrow, DOWN, buff=0.1)
        self.play(GrowArrow(arrow), Write(Fl), run_time=0.7)
        no = jp("押せるのは台車だけ。ボールには直接さわれない", 26, MUTED).to_edge(UP, buff=0.8)
        self.play(FadeIn(no), run_time=0.5)

        self.cue(4)
        self.play(FadeOut(VGroup(Lb, Ll, hb, hl, no)), run_time=0.4)
        tv = ValueTracker(0.0)
        cr.add_updater(lambda m: m.set_state(0.0, tv.get_value()))
        ml.add_updater(lambda m: m.next_to(cr.ball, LEFT, buff=0.2))
        self.play(tv.animate.set_value(0.5), run_time=0.8)
        cr.clear_updaters()
        ml.clear_updaters()
        state = VGroup(tex(r"\bm{s}=", 44),
                       VGroup(*[VGroup(tex(a, 40, c), jp(b, 22, MUTED)).arrange(RIGHT, buff=0.3)
                                for a, b, c in (("x", "台車の位置", TROLLEY), ("v", "台車の速度", TROLLEY),
                                                (r"\theta", "紐の角度", ANGLE), (r"\omega", "角速度", ANGLE))])
                       .arrange(DOWN, buff=0.12, aligned_edge=LEFT)).arrange(RIGHT, buff=0.3)
        state = card(state).to_corner(UR, buff=0.55)
        arc = Arc(radius=0.9, start_angle=-PI / 2, angle=0.5, arc_center=cr.pivot(), color=ANGLE, stroke_width=4)
        thl = tex(r"\theta", 36, ANGLE).move_to(cr.pivot() + 1.15 * np.array([np.sin(0.25), -np.cos(0.25), 0]))
        vert = DashedLine(cr.pivot(), cr.pivot() + DOWN * 1.2, color=MUTED)
        xs = DashedLine(cr.w2s(0, 1.25), cr.w2s(0, 0), color=MUTED, dash_length=0.08)
        self.add(xs)
        self.play(FadeIn(state, shift=RIGHT * 0.2), Create(vert), Create(arc), Write(thl), run_time=1.0)

        self.cue(5)
        self.play(FadeOut(VGroup(arc, thl, vert, Ml, state)), run_time=0.3)
        ml.add_updater(lambda m: m.next_to(cr.ball, LEFT, buff=0.2))
        self.play(tv.animate.set_value(0.0), UpdateFromFunc(cr, lambda m: m.set_state(0.0, tv.get_value())),
                  run_time=0.6)
        ml.clear_updaters()
        goal = Crane(k=3.0, at=DOWN * 2.1 + RIGHT * 0.1, opacity=0.45)
        goal.set_state(1.63, 0.0)
        s0 = VGroup(tex(r"x=0", 30), jp("静止", 22, MUTED)).arrange(RIGHT, buff=0.15).next_to(cr.w2s(0, 0), DOWN, 0.12)
        s1 = VGroup(tex(r"x=1.63\,\mathrm{m}", 30, OK), jp("静止", 22, OK)).arrange(RIGHT, buff=0.15)
        s1.next_to(cr.w2s(1.63, 0), DOWN, 0.12)
        go = CurvedArrow(cr.w2s(0.15, 1.45), cr.w2s(1.55, 1.45), angle=-PI / 4, color=OK)
        self.play(FadeIn(goal.body), FadeIn(s0), FadeIn(s1), Create(go), run_time=1.2)
        self.finish()


# --------------------------------------------------------------------------- 3
class S03Lagrange(NarratedScene):
    sid = "s03_lagrange"

    def construct(self):
        h = headline("ラグランジュの方法")
        self.play(FadeIn(h), run_time=0.5)
        # left: schematic with coordinates
        piv = LEFT * 4.4 + UP * 1.6
        th = 0.55
        bpos = piv + 3.0 * np.array([np.sin(th), -np.cos(th), 0])
        rail = Line(piv + LEFT * 2, piv + RIGHT * 2, color=RAIL, stroke_width=5)
        trol = Rectangle(width=0.6, height=0.25, fill_color=TROLLEY, fill_opacity=1, stroke_width=0).move_to(piv + UP * 0.12)
        stri = Line(piv, bpos, color=STRING, stroke_width=3)
        ball = Circle(0.17, fill_color=BALL, fill_opacity=1, stroke_width=0).move_to(bpos)
        vert = DashedLine(piv, piv + DOWN * 3.2, color=MUTED)
        arc = Arc(radius=0.8, start_angle=-PI / 2, angle=th, arc_center=piv, color=ANGLE, stroke_width=4)
        thl = tex(r"\theta", 34, ANGLE).move_to(piv + 1.05 * np.array([np.sin(th / 2), -np.cos(th / 2), 0]))
        xl = tex("x", 34, TROLLEY).next_to(trol, UP, buff=0.1)
        Ll = tex("L", 32, STRING).move_to(stri.get_center() + np.array([0.25, 0.1, 0]))
        fig = VGroup(rail, trol, vert, stri, ball, arc, thl, xl, Ll)
        self.play(FadeIn(fig), run_time=0.8)

        self.cue(1)
        q = card(VGroup(jp("一般化座標", 26, MUTED), tex(r"q = (x,\ \theta)", 40)).arrange(RIGHT, buff=0.35))
        q.move_to(RIGHT * 2.3 + UP * 1.85)
        self.play(FadeIn(q), Indicate(xl, color=TROLLEY), Indicate(thl, color=ANGLE), run_time=1.0)

        self.cue(2)
        pos = eq_rows([r"x_b = x + L\sin\theta", r"y_b = -L\cos\theta"], 40).move_to(RIGHT * 2.3 + UP * 0.55)
        bl = tex(r"(x_b,\ y_b)", 30, BALL).next_to(ball, RIGHT, buff=0.15)
        self.play(Write(pos[0]), FadeIn(bl), run_time=1.3)
        self.play(Write(pos[1]), run_time=1.0)

        self.cue(3)
        vel = eq_rows([r"\dot x_b = \dot x + L\dot\theta\cos\theta", r"\dot y_b = L\dot\theta\sin\theta"], 40)
        vel.move_to(pos)
        self.play(TransformMatchingTex(pos, vel), run_time=1.0)

        self.cue(4)
        T = tex(r"T = \tfrac12 M\dot x^2 + \tfrac12 m(\dot x_b^2+\dot y_b^2)", 38)
        T2 = tex(r"T = \tfrac12 (M+m)\dot x^2 + mL\dot x\dot\theta\cos\theta + \tfrac12 mL^2\dot\theta^2", 36)
        T.move_to(RIGHT * 2.3 + DOWN * 0.55)
        T2.move_to(RIGHT * 2.3 + DOWN * 0.55)
        self.play(Write(T), run_time=1.1)
        self.play(TransformMatchingTex(T, T2), run_time=1.1)

        self.cue(5)
        V = tex(r"V = mgL(1-\cos\theta)", 38).next_to(T2, DOWN, buff=0.3)
        self.play(Write(V), run_time=1.0)

        self.cue(6)
        Lg = tex(r"\mathcal{L} = T - V", 48, FORCE).next_to(V, DOWN, buff=0.3)
        box = SurroundingRectangle(Lg, color=FORCE, buff=0.18, corner_radius=0.1)
        self.play(Write(Lg), Create(box), run_time=1.0)
        self.finish()


# --------------------------------------------------------------------------- 4
class S04Euler(NarratedScene):
    sid = "s04_euler"

    def construct(self):
        h = headline("オイラー・ラグランジュ方程式")
        el1 = tex(r"\frac{d}{dt}\frac{\partial\mathcal L}{\partial\dot x}-\frac{\partial\mathcal L}{\partial x}", 44)
        el2 = tex(r"\frac{d}{dt}\frac{\partial\mathcal L}{\partial\dot\theta}-\frac{\partial\mathcal L}{\partial\theta}", 44)
        r1 = tex(r"= Q_x", 44)
        r2 = tex(r"= Q_\theta", 44)
        row1 = VGroup(el1, r1).arrange(RIGHT, buff=0.2)
        row2 = VGroup(el2, r2).arrange(RIGHT, buff=0.2)
        rows = VGroup(row1, row2).arrange(DOWN, buff=0.5, aligned_edge=LEFT).move_to(UP * 0.4)
        self.play(FadeIn(h), Write(rows), run_time=1.6)
        note = jp("右辺 = 外から働く力（一般化力）", 24, MUTED).next_to(rows, DOWN, buff=0.5)
        self.play(FadeIn(note), run_time=0.5)

        self.cue(1)
        q1 = tex(r"= F - b\dot x", 44, FORCE).move_to(r1, aligned_edge=LEFT)
        self.play(Transform(r1, q1), run_time=0.8)
        l1 = jp("押す力 − 台車の摩擦", 22, FORCE).next_to(q1, RIGHT, buff=0.3)
        self.play(FadeIn(l1), run_time=0.4)

        self.cue(2)
        q2 = tex(r"= -c\,\dot\theta", 44, ANGLE).move_to(r2, aligned_edge=LEFT)
        self.play(Transform(r2, q2), run_time=0.8)
        l2 = jp("支点の減衰", 22, ANGLE).next_to(q2, RIGHT, buff=0.3)
        self.play(FadeIn(l2), run_time=0.4)

        self.cue(3)
        e1 = MathTex(r"(M+m)\ddot x", r"+ mL\cos\theta\,\ddot\theta", r"- mL\dot\theta^2\sin\theta", r"= F - b\dot x",
                     font_size=44, color=TEXT)
        e2 = MathTex(r"mL\cos\theta\,\ddot x", r"+ mL^2\ddot\theta", r"+ mgL\sin\theta", r"= -c\,\dot\theta",
                     font_size=44, color=TEXT)
        e1[3].set_color(FORCE)
        e2[3].set_color(ANGLE)
        res = VGroup(e1, e2).arrange(DOWN, buff=0.45).move_to(UP * 0.3)
        self.play(FadeOut(VGroup(note, l1, l2)), ReplacementTransform(VGroup(row1), e1),
                  ReplacementTransform(VGroup(row2), e2), run_time=1.4)

        self.cue(4)
        t1 = jp("① 台車の横方向", 24, TROLLEY).next_to(e1, LEFT, buff=0.35)
        t2 = jp("② 振り子の回転", 24, ANGLE).next_to(e2, LEFT, buff=0.35)
        grp = VGroup(res, t1, t2)
        self.play(FadeIn(t1), FadeIn(t2), grp.animate.move_to(UP * 0.3), run_time=0.8)

        self.cue(5)
        b1 = SurroundingRectangle(e1[1], color=OK, buff=0.08)
        b2 = SurroundingRectangle(e2[0], color=OK, buff=0.08)
        cp = jp("もう一方の加速度が入る → 連成している", 26, OK).next_to(res, DOWN, buff=0.55)
        self.play(Create(b1), Create(b2), run_time=0.8)
        self.play(FadeIn(cp, shift=UP * 0.1), run_time=0.5)
        self.finish()


# --------------------------------------------------------------------------- 5
class S05Solve(NarratedScene):
    sid = "s05_solve"

    def construct(self):
        h = headline("加速度について解く")
        Mm = tex(r"\begin{bmatrix} M+m & mL\cos\theta \\ mL\cos\theta & mL^2 \end{bmatrix}", 42, ANGLE)
        acc = tex(r"\begin{bmatrix}\ddot x\\ \ddot\theta\end{bmatrix}", 42)
        rhs = tex(r"= \begin{bmatrix} F - b v + mL\omega^2\sin\theta \\ -mgL\sin\theta - c\,\omega\end{bmatrix}", 42)
        mat = VGroup(Mm, acc, rhs).arrange(RIGHT, buff=0.15).move_to(UP * 1.5)
        self.play(FadeIn(h), Write(mat), run_time=1.8)
        sub = tex(r"(v=\dot x,\ \omega=\dot\theta)", 30, MUTED).next_to(mat, DOWN, buff=0.25)
        self.play(FadeIn(sub), run_time=0.4)

        self.cue(1)
        br = Brace(Mm, DOWN, color=ANGLE)
        bl = jp("質量行列", 26, ANGLE).next_to(br, DOWN, buff=0.1)
        self.play(FadeOut(sub), GrowFromCenter(br), FadeIn(bl), run_time=0.8)

        self.cue(2)
        det = tex(r"\det = (M+m)mL^2 - m^2L^2\cos^2\theta", 40).next_to(bl, DOWN, buff=0.4)
        det2 = tex(r"\det = mL^2\,(M + m\sin^2\theta)", 40).move_to(det)
        self.play(Write(det), run_time=1.4)
        self.play(TransformMatchingTex(det, det2), run_time=1.2)
        pos = VGroup(tex(r"\geq mL^2 M > 0", 40, OK)).next_to(det2, RIGHT, buff=0.3)
        self.play(Write(pos), run_time=0.8)

        self.cue(3)
        sol = tex(r"\begin{bmatrix}\ddot x\\ \ddot\theta\end{bmatrix} = \frac{1}{\det}"
                  r"\begin{bmatrix} mL^2 & -mL\cos\theta \\ -mL\cos\theta & M+m \end{bmatrix}"
                  r"\begin{bmatrix} r_1 \\ r_2\end{bmatrix}", 40)
        sol.move_to(DOWN * 1.2)
        self.play(FadeOut(VGroup(br, bl)), VGroup(det2, pos).animate.scale(0.75).next_to(mat, DOWN, buff=0.3),
                  run_time=0.6)
        self.play(Write(sol), run_time=1.4)


        self.cue(4)
        f = tex(r"\dot{\bm s} = \begin{bmatrix} v \\ \ddot x(\bm s, F) \\ \omega \\ \ddot\theta(\bm s, F)\end{bmatrix}", 40)
        f.next_to(sol, DOWN, buff=0.35)
        self.play(FadeOut(mat), FadeOut(VGroup(det2, pos)), sol.animate.move_to(UP * 1.5), run_time=0.6)
        f.next_to(sol, DOWN, buff=0.35)
        self.play(Write(f), run_time=1.2)

        self.cue(5)
        key = tex(r"\dot{\bm s} = f(\bm s, F)", 72, FORCE)
        box = SurroundingRectangle(key, color=FORCE, buff=0.3, corner_radius=0.12)
        self.play(FadeOut(sol), ReplacementTransform(f, key), run_time=0.9)
        self.play(Create(box), run_time=0.6)
        lab = jp("ここから先の計算は、すべてこの式が土台", 26, MUTED).next_to(box, DOWN, buff=0.35)
        self.play(FadeIn(lab), run_time=0.5)
        self.finish()


# --------------------------------------------------------------------------- 6
class S06Tension(NarratedScene):
    sid = "s06_tension"

    def construct(self):
        h = headline("紐は押せない：張力の制約")
        rod = VGroup(Line(ORIGIN, DOWN * 1.8, color=STRING, stroke_width=10), jp("棒", 26, MUTED))
        rod[1].next_to(rod[0], UP)
        rope = VGroup(Line(ORIGIN, DOWN * 1.8, color=STRING, stroke_width=3), jp("紐", 26, MUTED))
        rope[1].next_to(rope[0], UP)
        pair = VGroup(rod, rope).arrange(RIGHT, buff=2.5).move_to(UP * 0.3)
        self.play(FadeIn(h), FadeIn(pair), run_time=0.8)

        self.cue(1)
        pull = Arrow(rope[0].get_bottom(), rope[0].get_bottom() + DOWN * 0.9, color=OK, buff=0)
        push = Arrow(rope[0].get_bottom() + DOWN * 0.9, rope[0].get_bottom(), color=BALL, buff=0)
        slack = VMobject(stroke_color=STRING, stroke_width=3)
        slack.set_points_smoothly([rope[0].get_top(), rope[0].get_top() + DOWN * 0.6 + RIGHT * 0.35,
                                   rope[0].get_top() + DOWN * 1.1 + LEFT * 0.25, rope[0].get_top() + DOWN * 1.4])
        okl = jp("引く：OK", 22, OK).next_to(pull, RIGHT)
        self.play(GrowArrow(pull), FadeIn(okl), run_time=0.8)
        self.wait(0.8)
        self.play(ReplacementTransform(pull, push), Transform(rope[0], slack), FadeOut(okl),
                  FadeIn(jp("押す：たるむ", 22, BALL).next_to(push, LEFT)), run_time=1.0)

        self.cue(2)
        self.play(*[FadeOut(m) for m in self.mobjects if m is not h], run_time=0.4)
        Tt = MathTex(r"T_s", r"= m\big(", r"g\cos\theta", r"+ L\omega^2", r"- \ddot x\sin\theta", r"\big)",
                     font_size=56, color=TEXT).move_to(UP * 1.4)
        self.play(Write(Tt), run_time=1.4)

        self.cue(3)
        cols = (ANGLE, PUMP, FORCE)
        labs = ("重力の成分", "遠心力", "台車の加速度")
        brs = VGroup()
        for part, c, lab in zip(Tt[2:5], cols, labs):
            part.set_color(c)
            b = Brace(part, DOWN, color=c)
            brs.add(VGroup(b, jp(lab, 22, c).next_to(b, DOWN, buff=0.08)))
        for b in brs:
            self.play(FadeIn(b), run_time=0.5)
            self.wait(0.9)

        self.cue(4)
        self.play(Indicate(Tt[4], color=FORCE, scale_factor=1.2), run_time=1.0)
        warn = jp("θ > 0 で ẍ > 0（前へ急加速）→ 張力が下がる", 26, FORCE).next_to(brs, DOWN, buff=0.3)
        self.play(FadeIn(warn), run_time=0.5)

        self.cue(5)
        d = data("tension")
        self.play(FadeOut(VGroup(brs, warn)), Tt.animate.scale(0.7).to_edge(UP, buff=1.6), run_time=0.5)
        ax, labs = plot_axes([0, 4, 1], [0, 30, 10], 8.5, 2.9, "時刻 [s]", "張力 [N]")
        ax.move_to(DOWN * 0.8)
        lim = DashedLine(ax.c2p(0, 1.5), ax.c2p(4, 1.5), color=BALL, stroke_width=3)
        limt = tex(r"T_s \ge 1.5\,\mathrm{N}", 30, BALL).next_to(ax.c2p(4, 1.5), RIGHT, buff=0.15)
        cv = curve(ax, d["t"], d["T"], OK)
        self.play(Create(ax), FadeIn(labs), Create(lim), Write(limt), run_time=1.0)
        self.play(Create(cv), run_time=2.5, rate_func=linear)
        k = int(np.argmin(d["T"][20:-20])) + 20
        self.play(Flash(ax.c2p(d["t"][k], d["T"][k]), color=BALL, flash_radius=0.3), run_time=0.8)
        self.finish()


# --------------------------------------------------------------------------- 7
class S07OCP(NarratedScene):
    sid = "s07_ocp"

    def construct(self):
        h = headline("軌道最適化として書く")
        q = jp("どんな F(t) で押せばいい？", 34).move_to(UP * 1.8)
        self.play(FadeIn(h), FadeIn(q), run_time=0.8)
        ax = Axes(x_range=[0, 4, 1], y_range=[-25, 25, 25], x_length=6, y_length=1.6,
                  axis_config={"color": MUTED, "stroke_width": 2}).move_to(DOWN * 0.3)
        g = [ax.plot(lambda t, a=a: 18 * np.sin(a * t) * np.exp(-0.2 * t), color=FORCE, stroke_opacity=0.5)
             for a in (1.3, 2.1, 3.3)]
        self.play(Create(ax), *[Create(c) for c in g], run_time=1.5)

        self.cue(1)
        self.play(FadeOut(VGroup(ax, *g, q)), run_time=0.4)
        obj = VGroup(tex(r"\min_{F(\cdot)}", 48), tex(r"\int_0^{T} F(t)^2\,dt", 48, FORCE)).arrange(RIGHT, buff=0.3)
        obj.move_to(UP * 1.85 + LEFT * 2.6)
        self.play(Write(obj[0]), run_time=0.8)

        self.cue(2)
        self.play(Write(obj[1]), run_time=1.0)
        ol = jp("＝ 力を使う総量をなるべく少なく", 24, FORCE).next_to(obj, RIGHT, buff=0.4)
        self.play(FadeIn(ol), run_time=0.4)

        self.cue(3)
        st = jp("制約", 26, MUTED)
        c1 = tex(r"\bm s(0) = \bm s_{\text{start}},\quad \bm s(T) = \bm s_{\text{goal}}", 38)
        c2 = tex(r"\dot{\bm s} = f(\bm s, F)", 38, ANGLE)
        rows = VGroup(c1, c2).arrange(DOWN, buff=0.25, aligned_edge=LEFT)
        more = VGroup(
            VGroup(tex(r"d_{\text{wall}}(\bm s) \ge 2\,\mathrm{cm}", 36), jp("壁とのすき間", 22, MUTED)),
            VGroup(tex(r"T_s(\bm s, F) \ge 1.5\,\mathrm{N}", 36), jp("紐の張力", 22, MUTED)),
            VGroup(tex(r"-0.97 \le x \le 3.17\,\mathrm{m}", 36), jp("レール", 22, MUTED)),
            VGroup(tex(r"|v| \le 4\,\mathrm{m/s},\quad |F| \le 40\,\mathrm{N}", 36), jp("速度・力の上限", 22, MUTED)),
        )
        for m in more:
            m.arrange(RIGHT, buff=0.3)
        more.arrange(DOWN, buff=0.2, aligned_edge=LEFT)
        left = VGroup(st, rows).arrange(DOWN, buff=0.2, aligned_edge=LEFT)
        cols = VGroup(left, more).arrange(RIGHT, buff=0.9, aligned_edge=UP)
        cols.next_to(obj, DOWN, buff=0.5).set_x(0)
        self.play(FadeIn(st), Write(c1), run_time=0.9)
        self.play(Write(c2), run_time=0.8)

        self.cue(4)
        for m in more:
            self.play(FadeIn(m, shift=RIGHT * 0.2), run_time=0.45)
            self.wait(1.1)
        self.finish()


# --------------------------------------------------------------------------- 8
class S08Shooting(NarratedScene):
    sid = "s08_shooting"

    def construct(self):
        h = headline("直接多重シューティング法")
        ax = Axes(x_range=[0, 4, 1], y_range=[-25, 25, 25], x_length=9, y_length=2.6,
                  axis_config={"color": MUTED, "stroke_width": 2}).move_to(DOWN * 0.1)
        g = ax.plot(lambda t: 16 * np.sin(2.2 * t) * np.exp(-0.25 * t) + 4 * np.sin(5 * t), color=FORCE)
        inf = jp("F(t)：連続な関数 ＝ 変数が無限個", 28, FORCE).next_to(ax, UP, buff=0.3)
        self.play(FadeIn(h), Create(ax), Create(g), FadeIn(inf), run_time=1.6)

        self.cue(1)
        pl = np.load(ROOT / "out" / "enter" / "fast" / "plan.npz")
        ax2, labs = plot_axes([0, 4, 1], [-25, 25, 25], 9, 2.6, "時刻 [s]", "F [N]")
        ax2.move_to(DOWN * 0.1)
        st = steps(ax2, pl["t"], pl["U"], FORCE, 2)
        lab = VGroup(tex(r"N = 200,\ \ \Delta t = 1/50\,\mathrm{s}", 32), jp("各区間で力は一定", 24, MUTED))
        lab.arrange(RIGHT, buff=0.4).next_to(ax2, UP, buff=0.3)
        self.play(FadeOut(VGroup(g, inf)), ReplacementTransform(ax, ax2), FadeIn(labs), run_time=0.6)
        self.play(Create(st), FadeIn(lab), run_time=2.0, rate_func=linear)

        self.cue(2)
        self.play(FadeOut(VGroup(ax2, labs, st, lab)), run_time=0.4)
        # schematic nodes and arcs with gaps
        xs = np.linspace(-5, 5, 5)
        ys = [0.3, 1.0, 0.1, 0.8, 0.2]
        nodes = VGroup(*[Dot([x, y - 0.3, 0], color=ANGLE, radius=0.09) for x, y in zip(xs, ys)])
        nl = VGroup(*[tex(fr"\bm s_{k}", 32, ANGLE).next_to(nodes[k], UP, buff=0.12) for k in range(5)])
        arcs, gaps = VGroup(), VGroup()
        for k in range(4):
            a = nodes[k].get_center()
            end = np.array([xs[k + 1], ys[k + 1] - 0.3 + (0.55 if k % 2 == 0 else -0.5), 0])
            arcs.add(ArcBetweenPoints(a, end, angle=-0.4, color=TEXT, stroke_width=3))
            gaps.add(DashedLine(end, nodes[k + 1].get_center(), color=BALL, stroke_width=3))
        self.play(FadeIn(nodes), FadeIn(nl), run_time=0.6)
        self.play(*[Create(a) for a in arcs], run_time=1.0)
        self.play(*[Create(gp) for gp in gaps], run_time=0.6)
        eq = tex(r"\bm s_{k+1} = \Phi_{\mathrm{RK4}}(\bm s_k, F_k)\qquad k = 0,\dots,N-1", 40)
        eq.next_to(nodes, DOWN, buff=1.0)
        self.play(Write(eq), run_time=1.4)
        gl = jp("↑ この等式が「つなぎ目のずれ = 0」", 24, BALL).next_to(eq, DOWN, buff=0.2)
        self.play(FadeIn(gl), run_time=0.4)

        self.cue(3)
        self.play(FadeOut(VGroup(nodes, nl, arcs, gaps, eq, gl)), run_time=0.4)
        sh = data("shooting")
        T, N = sh["T"], sh["N"]
        tn = np.linspace(0, T, N + 1)
        axx, lx = plot_axes([0, 4, 1], [-0.4, 2.0, 1], 5.6, 2.6, "t [s]", "台車 x [m]")
        axt, lt = plot_axes([0, 4, 1], [-1.0, 1.0, 0.5], 5.6, 2.6, "t [s]", "角度 θ [rad]")
        pan = VGroup(VGroup(axx, lx), VGroup(axt, lt)).arrange(RIGHT, buff=1.0).move_to(UP * 0.05)
        sub = jp("12 区間の小さな問題（壁なし）", 26, MUTED).next_to(pan, UP, buff=0.25)
        self.play(FadeIn(pan), FadeIn(sub), run_time=0.8)

        def draw(it):
            g = VGroup()
            X = np.asarray(it["X"])
            for ax, row in ((axx, 0), (axt, 1)):
                for k in range(N):
                    arc = np.asarray(it["arcs"][k])[row]
                    ts = np.linspace(tn[k], tn[k + 1], len(arc))
                    g.add(curve(ax, ts, arc, TEXT, 2.5))
                    g.add(DashedLine(ax.c2p(tn[k + 1], arc[-1]), ax.c2p(tn[k + 1], X[row, k + 1]),
                                     color=BALL, stroke_width=3, dash_length=0.05))
                for k in range(N + 1):
                    g.add(Dot(ax.c2p(tn[k], X[row, k]), radius=0.05, color=ANGLE))
            return g

        def info(i, it):
            return VGroup(jp(f"反復 {i}", 26), jp(f"つなぎ目のずれ 最大 {it['defect']:.3f}", 24,
                                                  BALL if it["defect"] > 1e-3 else OK)).arrange(RIGHT, buff=0.5) \
                .next_to(pan, DOWN, buff=0.12)

        cur, inf = draw(sh["iters"][0]), info(0, sh["iters"][0])
        self.play(FadeIn(cur), FadeIn(inf), run_time=0.8)

        self.cue(4)
        n_it = len(sh["iters"])
        per = (self.span(4) - 0.3) / (n_it - 1)
        for i in range(1, n_it):
            nxt, ninf = draw(sh["iters"][i]), info(i, sh["iters"][i])
            self.play(Transform(cur, nxt), Transform(inf, ninf), run_time=min(0.9, per))
            self.hold(per - 0.9)

        self.cue(5)
        self.play(FadeOut(VGroup(pan, sub, cur, inf)), run_time=0.4)
        cnt = VGroup(tex(r"\underbrace{4\times 201}_{\text{states}} + \underbrace{200}_{\text{forces}} = 1004", 44),
                     jp("変数：約 1000 個", 30)).arrange(DOWN, buff=0.35).move_to(UP * 0.8)
        self.play(Write(cnt[0]), FadeIn(cnt[1]), run_time=1.4)
        ip = card(VGroup(jp("非線形計画ソルバー", 26, MUTED), jp("IPOPT", 44, OK, weight="BOLD"),
                         jp("（CasADi から呼ぶ）", 22, MUTED)).arrange(RIGHT, buff=0.35)).next_to(cnt, DOWN, buff=0.5)
        self.play(FadeIn(ip, shift=UP * 0.2), run_time=0.7)
        self.finish()


# --------------------------------------------------------------------------- 9
class S09SDF(NarratedScene):
    sid = "s09_sdf"

    def construct(self):
        h = headline("壁とのすき間：符号付き距離関数")
        k = 4.2
        o = np.array([-2.2, -2.35, 0])  # screen point of the wall's bottom-centre
        hw, hh = 0.06, 0.75
        w2s = lambda x, y: o + k * np.array([x, y, 0])
        wall = Rectangle(width=2 * hw * k, height=hh * k, fill_color=BRICK, fill_opacity=1, stroke_width=0)
        wall.move_to(w2s(0, hh / 2))
        floor = Line(w2s(-0.8, 0), w2s(0.8, 0), color=FLOOR, stroke_width=6)

        def iso(d, color, width=2, opacity=0.7):
            pts = [w2s(-hw - d, 0), w2s(-hw - d, hh)]
            pts += [w2s(-hw - d * np.cos(a), hh + d * np.sin(a)) for a in np.linspace(0, PI / 2, 12)[1:]]
            pts += [w2s(hw + d * np.sin(a), hh + d * np.cos(a)) for a in np.linspace(0, PI / 2, 12)]
            pts += [w2s(hw + d, 0)]
            m = VMobject(stroke_color=color, stroke_width=width, stroke_opacity=opacity)
            m.set_points_as_corners(pts)
            return m

        isos = VGroup(*[iso(d, ANGLE, 2, 0.25 + 0.5 * (1 - d / 0.3)) for d in (0.05, 0.1, 0.15, 0.2, 0.25, 0.3)])
        self.play(FadeIn(h), FadeIn(floor), FadeIn(wall), run_time=0.6)
        self.play(LaggedStart(*[Create(i) for i in isos], lag_ratio=0.15), run_time=1.6)

        self.cue(1)
        pt = ValueTracker(0.0)
        path = lambda s: np.array([-0.3 + 0.55 * s, 0.55 + 0.35 * np.sin(PI * s), 0])

        def sdf(p):
            qx, qy = abs(p[0]) - hw, p[1] - hh
            return np.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0)

        dot = always_redraw(lambda: Dot(w2s(*path(pt.get_value())[:2]), color=FORCE, radius=0.08))
        val = always_redraw(lambda: VGroup(tex(r"d =", 36), DecimalNumber(sdf(path(pt.get_value())) * 100,
                                                                         num_decimal_places=1, font_size=36,
                                                                         color=OK if sdf(path(pt.get_value())) > 0 else BALL),
                                           tex(r"\mathrm{cm}", 36)).arrange(RIGHT, buff=0.15)
                            .move_to(RIGHT * 3.4 + UP * 1.4))
        sg = VGroup(jp("外：プラス", 26, OK), jp("中：マイナス", 26, BALL)).arrange(DOWN, aligned_edge=LEFT)
        sg.next_to(val, DOWN, buff=0.4).align_to(val, LEFT)
        self.add(dot, val)
        self.play(FadeIn(sg), run_time=0.4)
        self.play(pt.animate.set_value(1.0), run_time=self.until(2, -0.2), rate_func=there_and_back_with_pause)

        self.cue(2)
        self.remove(dot, val)
        self.play(FadeOut(sg), run_time=0.3)
        bc = w2s(-0.2, 0.86)
        ball = Circle(radius=0.06 * k, fill_color=BALL, fill_opacity=1, stroke_width=0).move_to(bc)
        con = card(VGroup(tex(r"d(\text{ball centre}) - r \;\ge\; 2\,\mathrm{cm}", 38),
                          jp("r：ボールの半径 6 cm", 22, MUTED)).arrange(DOWN, buff=0.15)).move_to(RIGHT * 3.4 + UP * 1.2)
        self.play(FadeIn(ball, scale=0.5), FadeIn(con), Indicate(isos[0], color=FORCE), run_time=1.0)

        self.cue(3)
        piv = w2s(-0.42, 1.02)
        stri = Line(piv, bc, color=STRING, stroke_width=3)
        lams = np.linspace(0.3, 1.0, 8, endpoint=False)
        dots = VGroup(*[Dot(piv + l * (bc - piv), radius=0.05, color=FORCE) for l in lams])
        self.play(Create(stri), run_time=0.5)
        self.play(LaggedStart(*[FadeIn(d, scale=0.3) for d in dots], lag_ratio=0.1), run_time=1.0)
        s8 = jp("紐の上の 8 点も ≥ 2 cm", 24, FORCE).next_to(con, DOWN, buff=0.3)
        self.play(FadeIn(s8), run_time=0.4)

        self.cue(4)
        self.play(FadeOut(VGroup(ball, stri, dots, s8, con)), run_time=0.3)
        ax = Axes(x_range=[-1, 1, 1], y_range=[0, 1, 1], x_length=3.2, y_length=1.8,
                  axis_config={"color": MUTED, "stroke_width": 2}).move_to(RIGHT * 3.4 + UP * 0.6)
        sharp = ax.plot(lambda a: abs(a), color=MUTED, stroke_width=3)
        smooth = ax.plot(lambda a: np.sqrt(a * a + 0.05), color=OK, stroke_width=4)
        f1 = tex(r"|a|", 32, MUTED).next_to(ax, UP, buff=0.1).shift(LEFT * 0.9)
        f2 = tex(r"\sqrt{a^2+\varepsilon^2}", 32, OK).next_to(ax, UP, buff=0.1).shift(RIGHT * 0.7)
        self.play(Create(ax), Create(sharp), FadeIn(f1), run_time=0.9)
        self.play(Create(smooth), FadeIn(f2), run_time=0.9)
        cap = jp("角を丸めて微分できるように", 24, OK).next_to(ax, DOWN, buff=0.3)
        self.play(FadeIn(cap), run_time=0.4)
        self.finish()


# --------------------------------------------------------------------------- 10
class S10Homotopy(NarratedScene):
    sid = "s10_homotopy"

    def construct(self):
        h = headline("ホモトピー法（継続法）")
        hd = data("homotopy")
        steps_ = hd["steps"]
        cr = Crane(k=2.6, at=DOWN * 2.2 + RIGHT * 0.2)
        cr.set_state(0, 0)
        self.play(FadeIn(h), FadeIn(cr), run_time=0.8)
        fail = jp("いきなり本物の壁 → 失敗しやすい", 28, BALL).next_to(h, DOWN, buff=0.35)
        self.play(FadeIn(fail), Indicate(cr.walls, color=BALL), run_time=1.2)

        self.cue(1)
        self.play(FadeOut(fail), run_time=0.3)

        def walls_at(a):
            return VGroup(*[cr.make_wall(x0, x1, a * 0.75) for x0, x1 in ((1.30, 1.42), (1.84, 1.96))])

        def ball_path(s, color, op=1.0):
            m = VMobject(stroke_color=color, stroke_width=3.5, stroke_opacity=op)
            m.set_points_as_corners([cr.w2s(a, b) for a, b in zip(s["bx"], s["by"])])
            return m

        self.remove(cr.walls)
        wl = walls_at(steps_[0]["scale"])
        self.add(wl)
        info = lambda s: VGroup(jp(f"壁の高さ {s['scale'] * 100:.0f} %", 30, weight="BOLD"),
                                jp(f"力のピーク {s['peak']:.1f} N", 24, FORCE)).arrange(DOWN, aligned_edge=LEFT) \
            .to_corner(UL, buff=0.7).shift(DOWN * 0.9)
        cur_info = info(steps_[0])
        paths = VGroup()
        cols = color_gradient([ANGLE, BALL], len(steps_))
        p0 = ball_path(steps_[0], cols[0])
        self.play(FadeIn(cur_info), Create(p0), cr.body.animate.set_opacity(0.3), run_time=1.2)
        paths.add(p0)
        per = (self.starts[3] - 0.3 - self.now) / (len(steps_) - 1)
        for i, s in enumerate(steps_[1:], 1):
            nw = walls_at(s["scale"])
            for p in paths:
                p.set_stroke(opacity=0.25)
            pn = ball_path(s, cols[i])
            self.play(Transform(wl, nw), Transform(cur_info, info(s)), Create(pn), run_time=min(1.1, per))
            paths.add(pn)
            self.hold(per - 1.1)
            if i == 2:
                self.cue(2)
                note = jp("失敗したら刻みを半分にしてやり直す", 24, MUTED).to_corner(UR, buff=0.7).shift(DOWN * 0.9)
                self.play(FadeIn(note), run_time=0.4)

        self.cue(3)
        self.play(FadeOut(VGroup(cr, wl, paths, cur_info, note)), run_time=0.5)
        h2 = headline("局所解がたくさんある")
        self.play(ReplacementTransform(h, h2), run_time=0.5)
        lo = data("localopt")

        def panel(key, color, title):
            c = Crane(k=1.65, at=np.array([0, -1.6, 0]), xlim=(-1.45, 2.25))
            d = lo[key]
            c.set_state(d["x"][0], d["th"][0])
            p = VMobject(stroke_color=color, stroke_width=3)
            p.set_points_as_corners([c.w2s(a, b) for a, b in zip(d["bx"], d["by"])])
            ttl = VGroup(jp(title, 24, color, weight="BOLD"),
                         jp(f"力のピーク {d['peak']:.0f} N", 24, color)).arrange(DOWN, buff=0.08)
            ttl.next_to(c, UP, buff=0.2)
            return VGroup(c, p, ttl), c, p

        A, ca_, pa = panel("continuation", BALL, "ホモトピー法だけ")
        B, cb_, pb = panel("seed", OK, "すき間の中で揺らしてから出す")
        VGroup(A, B).arrange(RIGHT, buff=0.7).move_to(DOWN * 0.3)
        noncvx = jp("壁の制約は非凸 → 初期値しだいで答えが変わる", 26, MUTED).next_to(h2, DOWN, buff=0.3)
        self.play(FadeIn(noncvx), run_time=0.5)
        self.play(FadeIn(A[0]), FadeIn(B[0]), run_time=0.8)

        self.cue(4)
        self.play(Create(pa), FadeIn(A[2]), run_time=2.0)

        self.cue(5)
        self.play(Create(pb), FadeIn(B[2]), run_time=2.0)

        self.cue(6)
        self.play(FadeOut(VGroup(A, B, noncvx)), run_time=0.4)
        starts = VGroup(*[card(jp(s, 20), pad=0.15) for s in
                          ("ゼロから", "逆再生", "保存した種", "種の逆再生", "種の引き伸ばし")]).arrange(DOWN, buff=0.15)
        starts.move_to(LEFT * 4 + DOWN * 0.3)
        best = card(VGroup(jp("目的関数が最小のものを採用", 24, OK)), pad=0.2).move_to(RIGHT * 3.5 + DOWN * 0.3)
        arrows = VGroup(*[Arrow(s.get_right(), best.get_left(), color=MUTED, stroke_width=3, buff=0.15) for s in starts])
        self.play(LaggedStart(*[FadeIn(s) for s in starts], lag_ratio=0.1), run_time=0.8)
        self.play(LaggedStart(*[GrowArrow(a) for a in arrows], lag_ratio=0.1), FadeIn(best), run_time=1.0)
        self.finish()


# --------------------------------------------------------------------------- 11
class S11Reverse(NarratedScene):
    sid = "s11_reverse"

    def construct(self):
        h = headline("時間反転")
        tr = traj("enter", "fast")
        n = int(np.searchsorted(tr["t"], tr["t_plan"])) + 1
        t, x, th = tr["t"][:n], tr["x"][:n], tr["theta"][:n]
        cr = Crane(k=2.4, at=DOWN * 2.4 + RIGHT * 0.2)
        cr.set_state(x[0], th[0])
        self.play(FadeIn(h), FadeIn(cr), run_time=0.8)

        self.cue(1)
        eq = VGroup(tex(r"t \to T-t", 40, ANGLE), jp("でも運動方程式は成り立つ（摩擦を除く）", 26)).arrange(RIGHT, buff=0.4)
        eq.next_to(h, DOWN, buff=0.35)
        self.play(FadeIn(eq), run_time=0.7)
        vt = cr.player(t, x, th)
        fw = cr.trace(ANGLE, 3, 0.8)
        self.add(fw)
        self.play(vt.animate.set_value(t[-1]), run_time=min(t[-1], self.until(2, -0.2)), rate_func=linear)

        self.cue(2)
        tag = jp("◀ 逆再生 ＝ すき間から出す動き", 28, FORCE).next_to(eq, DOWN, buff=0.25)
        self.play(FadeIn(tag), run_time=0.4)
        fw.clear_updaters()
        bw = cr.trace(FORCE, 3, 0.9)
        self.add(bw)
        self.play(vt.animate.set_value(t[0]), run_time=min(t[-1], self.until(3, -0.2)), rate_func=linear)
        cr.clear_updaters()
        bw.clear_updaters()

        self.cue(3)
        self.play(FadeOut(VGroup(tag, eq)), VGroup(cr, fw, bw).animate.scale(0.75, about_point=DOWN * 2.4),
                  run_time=0.5)
        fr = card(VGroup(tex(r"F_{\text{rev}}(t) = F(T-t) - 2b\,v(T-t)", 42, FORCE),
                         jp("台車の摩擦 b v の向きが逆になる分を補正", 22, MUTED)).arrange(DOWN, buff=0.15))
        fr.next_to(h, DOWN, buff=0.35)
        self.play(FadeIn(fr, shift=DOWN * 0.2), run_time=0.8)

        self.cue(4)
        c = jp("残るのは支点のごく小さな減衰 c だけ → ほぼ実行可能な初期値", 26, OK).next_to(fr, DOWN, buff=0.25)
        self.play(FadeIn(c), run_time=0.6)
        self.finish()


# --------------------------------------------------------------------------- 12
class S12TVLQR(NarratedScene):
    sid = "s12_tvlqr"

    def construct(self):
        h = headline("時変LQRで計画を追いかける")
        d = data("tvlqr")
        t = np.asarray(d["t"])
        cr = Crane(k=2.5, at=DOWN * 2.25 + RIGHT * 0.3, ball_color=BALL)
        o = d["open"]
        cr.set_state(o["x"][0], o["th"][0])
        tag = VGroup(jp("計画した力をそのまま流す（開ループ）", 26, BALL), jp("ボールが 5 % 重い", 22, MUTED))
        tag.arrange(DOWN, buff=0.1).next_to(h, DOWN, buff=0.3)
        self.play(FadeIn(h), FadeIn(cr), FadeIn(tag), run_time=0.8)

        self.cue(1)
        hit = o["hit"]
        vt = cr.player(t[: hit + 1], np.asarray(o["x"])[: hit + 1], np.asarray(o["th"])[: hit + 1])
        tp = cr.trace(BALL, 3, 0.8)
        self.add(tp)
        self.play(vt.animate.set_value(t[hit]), run_time=t[hit], rate_func=linear)
        cr.clear_updaters()
        tp.clear_updaters()
        self.play(Flash(cr.ball, color=BALL, flash_radius=0.5, num_lines=12), run_time=0.6)
        bang = jp("衝突！", 36, BALL, weight="BOLD").move_to(cr.w2s(1.63, 1.02))
        self.play(FadeIn(bang, scale=1.3), run_time=0.3)

        self.cue(2)
        self.play(FadeOut(VGroup(cr, tp, bang, tag)), run_time=0.4)
        e1 = tex(r"\delta\bm s = \bm s - \bm s^\star", 40)
        e2 = tex(r"\delta\bm s_{k+1} \approx A_k\,\delta\bm s_k + B_k\,\delta F_k", 42, ANGLE)
        g = VGroup(e1, e2).arrange(DOWN, buff=0.3).move_to(UP * 1.1)
        s = jp("s*：計画した軌道", 22, MUTED).next_to(e1, RIGHT, buff=0.4)
        self.play(Write(e1), FadeIn(s), run_time=0.9)
        self.play(Write(e2), run_time=1.3)

        self.cue(3)
        J = tex(r"\min\ \sum_k \left(\delta\bm s_k^{\!\top} Q\,\delta\bm s_k + R\,\delta F_k^2\right)", 40)
        J.next_to(e2, DOWN, buff=0.35)
        self.play(Write(J), run_time=1.2)

        self.cue(4)
        self.play(FadeOut(VGroup(e1, s)), VGroup(e2, J).animate.scale(0.8).to_edge(UP, buff=1.55), run_time=0.5)
        ric = VGroup(tex(r"K_k = (R + B_k^{\!\top} P_{k+1} B_k)^{-1} B_k^{\!\top} P_{k+1} A_k", 36),
                     tex(r"P_k = Q + A_k^{\!\top} P_{k+1}(A_k - B_k K_k)", 36)).arrange(DOWN, buff=0.15)
        ric.next_to(J, DOWN, buff=0.3)
        back = jp("k = N−1 → 0 へ逆向きに解く", 22, ANGLE).next_to(ric, RIGHT, buff=0.3)
        self.play(Write(ric), FadeIn(back), run_time=1.4)
        K = d["K"]
        ax, labs = plot_axes([0, 4, 1], [-60, 60, 60], 7.5, 1.6, "時刻 [s]", "")
        ax.next_to(ric, DOWN, buff=0.35)
        kc = [curve(ax, K["t"], K["k"][i], c, 2.5) for i, c in enumerate((TROLLEY, "#93c5fd", ANGLE, "#7dd3fc"))]
        kl = VGroup(*[tex(s_, 26, c) for s_, c in ((r"K_x", TROLLEY), (r"K_v", "#93c5fd"), (r"K_\theta", ANGLE),
                                                    (r"K_\omega", "#7dd3fc"))]).arrange(RIGHT, buff=0.3)
        kl.next_to(ax, RIGHT, buff=0.2)
        self.play(Create(ax), *[Create(c) for c in kc], FadeIn(kl), run_time=2.0)

        self.cue(5)
        self.play(FadeOut(VGroup(ax, *kc, kl, back)), run_time=0.3)
        law = tex(r"F_k = F_k^\star - K_k\,(\bm s_k - \bm s_k^\star)", 50, FORCE).next_to(ric, DOWN, buff=0.45)
        box = SurroundingRectangle(law, color=FORCE, buff=0.2, corner_radius=0.1)
        self.play(Write(law), Create(box), run_time=1.3)

        self.cue(6)
        self.play(FadeOut(VGroup(e2, J, ric, law, box)), run_time=0.3)
        c = d["closed"]
        cr2 = Crane(k=2.5, at=DOWN * 2.25 + RIGHT * 0.3)
        cr2.set_state(c["x"][0], c["th"][0])
        tag2 = VGroup(jp("時変LQRあり", 26, OK), jp("同じ 5 % 重いボール", 22, MUTED)).arrange(DOWN, buff=0.1)
        tag2.next_to(h, DOWN, buff=0.3)
        self.add(cr2, tag2)
        vt2 = cr2.player(t, np.asarray(c["x"]), np.asarray(c["th"]))
        tc = cr2.trace(OK, 3, 0.8)
        self.add(tc)
        run = max(1.0, self.total - self.now - 0.6)
        self.play(vt2.animate.set_value(t[-1]), run_time=run, rate_func=lambda a: a)
        self.finish()


# --------------------------------------------------------------------------- 13
class S13Verify(NarratedScene):
    sid = "s13_verify"

    def construct(self):
        h = headline("本当に大丈夫か確かめる")
        self.play(FadeIn(h), run_time=0.5)

        self.cue(1)
        a = card(VGroup(jp("計画", 26, MUTED), jp("RK4・50 Hz の格子", 28)).arrange(DOWN, buff=0.12))
        b = card(VGroup(jp("検証", 26, MUTED), jp("DOP853（rtol 1e-10）", 28, OK), jp("連続時間のまま積分", 22, MUTED))
                 .arrange(DOWN, buff=0.12))
        row = VGroup(a, b).arrange(RIGHT, buff=1.4).move_to(UP * 1.5)
        arr = Arrow(a.get_right(), b.get_left(), color=MUTED)
        self.play(FadeIn(a), run_time=0.6)
        self.play(GrowArrow(arr), FadeIn(b), run_time=0.8)

        self.cue(2)
        ax = Axes(x_range=[0, 0.2, 0.02], y_range=[0, 12, 4], x_length=7.5, y_length=1.7,
                  axis_config={"color": MUTED, "stroke_width": 2}).move_to(DOWN * 1.35)
        tt = np.linspace(0, 0.2, 400)
        f = lambda s: 8 + 3 * np.sin(22 * s)
        cont = ax.plot(f, x_range=[0, 0.2], color=MUTED, stroke_opacity=0.6)
        tk = np.arange(0, 0.2 + 1e-9, 0.02)
        zoh = steps(ax, tk, f(tk[:-1]), FORCE, 3)
        zl = jp("50 Hz で力を更新、その間は一定（ゼロ次ホールド）", 24, FORCE).next_to(ax, UP, buff=0.25)
        self.play(Create(ax), Create(cont), run_time=0.8)
        self.play(Create(zoh), FadeIn(zl), run_time=1.4)

        self.cue(3)
        self.play(FadeOut(VGroup(ax, cont, zoh, zl, a, b, arr)), run_time=0.4)
        reps = {(m, p): json.loads((ROOT / "out" / m / p / "report.json").read_text())
                for m in ("enter", "escape") for p in ("fast", "pump")}
        cols = [("enter", "fast"), ("escape", "fast"), ("enter", "pump"), ("escape", "pump")]
        hdr = [jp("", 22)] + [jp(f"{m} / {p}", 22, MUTED) for m, p in cols]
        r1 = [jp("最小すき間", 24)] + [jp(f"{reps[c]['min_ball_clearance_m'] * 100:.2f} cm", 26, OK) for c in cols]
        r2 = [jp("最小張力", 24)] + [jp(f"{reps[c]['min_tension_N']:.3f} N", 26, OK) for c in cols]
        r3 = [jp("力の最大値", 24)] + [jp(f"{reps[c]['peak_force_N']:.1f} N", 26, FORCE) for c in cols]
        r4 = [jp("判定", 24)] + [jp("OK" if reps[c]["ok"] else "NG", 26, OK, weight="BOLD") for c in cols]
        tbl = MobjectTable([hdr, r1, r2, r3, r4], include_outer_lines=False,
                           line_config={"stroke_color": GRID, "stroke_width": 1.5}, h_buff=0.6, v_buff=0.3)
        tbl.move_to(DOWN * 0.1)
        self.play(FadeIn(tbl), run_time=1.0)
        self.play(Indicate(VGroup(*r1[1:], *r2[1:]), color=OK, scale_factor=1.05), run_time=1.2)

        self.cue(4)
        self.play(tbl.animate.scale(0.7).to_edge(UP, buff=1.5), run_time=0.5)
        rb = VGroup(jp("ただし モデル誤差に弱い", 30, BALL, weight="BOLD"),
                    jp("enter / fast：紐が +1.8 % 長いだけで壁に接触", 26),
                    jp("1000 回のモンテカルロで成功率 91 %（enter / fast）", 22, MUTED)).arrange(DOWN, buff=0.2)
        rb.next_to(tbl, DOWN, buff=0.5)
        self.play(FadeIn(rb, shift=UP * 0.2), run_time=0.8)
        self.finish()


# --------------------------------------------------------------------------- 14
class S14Pump(NarratedScene):
    sid = "s14_pump"

    def construct(self):
        h = headline("おまけ：共振で押す（pump）")
        tr = traj("enter", "pump")
        cr = Crane(k=2.35, at=DOWN * 2.3 + RIGHT * 0.5, xlim=(-1.5, 2.3))
        cr.set_state(tr["x"][0], tr["theta"][0])
        tg = VGroup(jp("T = 12 s", 26, PUMP), jp("力の最大値を最小に", 26, PUMP)).arrange(RIGHT, buff=0.5)
        tg.next_to(h, DOWN, buff=0.3)
        self.play(FadeIn(h), FadeIn(cr), FadeIn(tg), run_time=0.8)
        vt = cr.player(tr["t"], tr["x"], tr["theta"])
        tp = cr.trace(PUMP, 2.5, 0.6)
        self.add(tp)
        speed = tr["t"][-1] / (self.starts[2] - self.now - 0.3)
        spd = jp(f"×{speed:.1f} 速", 22, MUTED).to_corner(UR, buff=0.7).shift(DOWN * 0.6)
        self.add(spd)
        self.play(vt.animate.set_value(tr["t"][-1]), run_time=self.starts[2] - self.now - 0.3, rate_func=linear)
        cr.clear_updaters()
        tp.clear_updaters()

        self.cue(2)
        self.play(FadeOut(VGroup(cr, tp, spd, tg)), run_time=0.4)
        e = VGroup(tex(r"\min_{F,\,p}\ \ 20\,p + \int F^2\,dt", 44),
                   tex(r"-p \le F_k \le p", 44, PUMP)).arrange(DOWN, buff=0.35).move_to(UP * 0.8)
        self.play(Write(e[0]), run_time=1.2)
        self.play(Write(e[1]), run_time=1.0)
        n = jp("max|F| の角をなくして、滑らかな問題のまま解く（エピグラフ形式）", 24, MUTED).next_to(e, DOWN, buff=0.35)
        self.play(FadeIn(n), run_time=0.5)

        self.cue(3)
        self.play(FadeOut(VGroup(e, n)), run_time=0.3)
        vals = (("fast（T = 4 s）", 20.6, FORCE), ("pump（T = 12 s）", 12.3, PUMP))
        bars = VGroup()
        for name, v, c in vals:
            bar = Rectangle(width=v * 0.33, height=0.7, fill_color=c, fill_opacity=0.9, stroke_width=0)
            lab = jp(name, 26).next_to(bar, LEFT, buff=0.3)
            num = jp(f"{v} N", 28, c, weight="BOLD").next_to(bar, RIGHT, buff=0.2)
            bars.add(VGroup(lab, bar, num))
        for i, b in enumerate(bars):
            b[1].move_to(np.array([-1.5 + b[1].width / 2, 0.8 - 1.1 * i, 0]))
            b[0].next_to(b[1], LEFT, buff=0.3).align_to(np.array([-1.8, 0, 0]), RIGHT)
            b[2].next_to(b[1], RIGHT, buff=0.2)
        ttl = jp("力の最大値", 28, MUTED).next_to(bars, UP, buff=0.4)
        self.play(FadeIn(ttl), *[GrowFromEdge(b[1], LEFT) for b in bars], *[FadeIn(b[0]) for b in bars],
                  *[FadeIn(b[2]) for b in bars], run_time=1.2)
        self.finish()


# --------------------------------------------------------------------------- 15
class S15Summary(NarratedScene):
    sid = "s15_summary"

    def construct(self):
        h = headline("まとめ")
        self.play(FadeIn(h), run_time=0.4)
        items = [("ラグランジュ", r"\dot{\bm s} = f(\bm s, F)", ANGLE),
                 ("多重シューティング + IPOPT", r"\min \int F^2 dt", FORCE),
                 ("時変LQR", r"F = F^\star - K\,\delta\bm s", OK)]
        boxes = VGroup(*[card(VGroup(jp(a, 26, c, weight="BOLD"), tex(b, 36)).arrange(DOWN, buff=0.2))
                         for a, b, c in items]).arrange(RIGHT, buff=0.7).move_to(UP * 0.5)
        arrows = VGroup(*[Arrow(boxes[i].get_right(), boxes[i + 1].get_left(), buff=0.1, color=MUTED)
                          for i in range(2)])
        for i in range(3):
            self.cue(i + 1)
            self.play(FadeIn(boxes[i], shift=UP * 0.2), *([GrowArrow(arrows[i - 1])] if i else []), run_time=0.6)
        self.cue(4)
        gh = card(VGroup(jp("コード", 24, MUTED), jp("github.com/Raptor-zip/crane-ball-wall", 30, weight="BOLD"))
                  .arrange(RIGHT, buff=0.4)).next_to(boxes, DOWN, buff=0.7)
        self.play(FadeIn(gh, shift=UP * 0.2), run_time=0.6)
        self.finish()
