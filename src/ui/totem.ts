/**
 * The HUD totem: a spinning top drawn in 2D. Its wobble is the dream's
 * instability. It never falls. (Or does it?)
 */
export class Totem {
  private ctx: CanvasRenderingContext2D;
  private spin = 0;
  private precess = 0;
  private tilt = 0;
  private w: number;
  private h: number;
  constructor(canvas: HTMLCanvasElement) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = (this.w = canvas.width);
    const h = (this.h = canvas.height);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
  }

  draw(dt: number, instability: number, accent: string): void {
    const c = this.ctx;
    const { w, h } = this;
    this.spin += dt * 22;
    this.precess += dt * (2.2 + instability * 3);
    const targetTilt = 0.05 + instability * 0.32;
    this.tilt += (targetTilt - this.tilt) * Math.min(1, dt * 3);
    c.clearRect(0, 0, w, h);

    const baseX = w / 2;
    const baseY = h - 12;
    // shadow
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.beginPath();
    c.ellipse(baseX + Math.sin(this.precess) * this.tilt * 10, baseY + 2, 13, 3, 0, 0, Math.PI * 2);
    c.fill();

    c.save();
    c.translate(baseX, baseY);
    c.rotate(Math.sin(this.precess) * this.tilt);
    const H = h - 22;
    const prof: [number, number][] = [
      [0.0, 0],
      [0.05, 0.03],
      [0.16, 0.14],
      [0.3, 0.28],
      [0.4, 0.38],
      [0.43, 0.43],
      [0.42, 0.47],
      [0.36, 0.52],
      [0.2, 0.58],
      [0.08, 0.62],
      [0.06, 0.64],
      [0.055, 0.93],
      [0.075, 0.96],
      [0.06, 0.99],
      [0.0, 1],
    ];
    const W = H * 0.95;
    const grad = c.createLinearGradient(-W / 2, 0, W / 2, 0);
    grad.addColorStop(0, '#6f675b');
    grad.addColorStop(0.35, '#e9dfc9');
    grad.addColorStop(0.55, '#b8ab90');
    grad.addColorStop(1, '#4a443b');
    c.fillStyle = grad;
    c.beginPath();
    prof.forEach(([x, y], i) => (i ? c.lineTo(x * W, -y * H) : c.moveTo(x * W, -y * H)));
    for (let i = prof.length - 1; i >= 0; i--) c.lineTo(-prof[i][0] * W, -prof[i][1] * H);
    c.closePath();
    c.fill();

    // engraved bands sliding across the body sell the spin
    c.save();
    c.clip();
    c.strokeStyle = 'rgba(40,34,26,0.55)';
    c.lineWidth = 1;
    for (let k = 0; k < 6; k++) {
      const a = this.spin + (k * Math.PI) / 3;
      const s = Math.sin(a);
      if (Math.cos(a) < 0) continue;
      c.beginPath();
      c.moveTo(s * W * 0.43, -0.43 * H);
      c.lineTo(s * W * 0.16, -0.14 * H);
      c.stroke();
    }
    c.strokeStyle = accent;
    c.globalAlpha = 0.7;
    c.beginPath();
    c.moveTo(-W * 0.42, -0.45 * H);
    c.lineTo(W * 0.42, -0.45 * H);
    c.stroke();
    c.restore();
    c.restore();
  }
}
