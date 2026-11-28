"""Original, royalty-free upbeat background track for the explainer videos (synthesised, no samples)."""
import numpy as np, sys
from scipy.signal import butter, sosfilt
from scipy.io import wavfile
SR = 44100; BPM = 104; BEAT = 60 / BPM; DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 31.4
OUT = sys.argv[1]; SEMI = int(sys.argv[3]) if len(sys.argv) > 3 else 0
N = int(SR * DUR); L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(7)
def f(m): return 440 * 2 ** ((m + SEMI - 69) / 12)
def env(n, a, d, s, r, hold):
    e = np.zeros(n); A = int(a*SR); D = int(d*SR); H = int(hold*SR); Rr = int(r*SR)
    e[:A] = np.linspace(0, 1, A, False); e[A:A+D] = np.linspace(1, s, D, False); e[A+D:H] = s
    e[H:H+Rr] = np.linspace(s, 0, min(Rr, n-H)) if H < n else 0
    return e
def add(sig, t0, gl=1, gr=1):
    i = int(t0*SR); j = min(N, i+len(sig))
    if i >= N: return
    L[i:j] += sig[:j-i]*gl; R[i:j] += sig[:j-i]*gr
def lp(x, hz): return sosfilt(butter(2, hz, 'low', fs=SR, output='sos'), x)
def hp(x, hz): return sosfilt(butter(2, hz, 'high', fs=SR, output='sos'), x)
# I–V–vi–IV in C : C G Am F
prog = [[60,64,67,72],[55,59,62,67],[57,60,64,69],[53,57,60,65]]
bass = [36,43,45,41]
bar = 4*BEAT; bars = int(DUR/bar)+1
for b in range(bars):
    t = b*bar; ch = prog[b % 4]
    # warm pad (detuned saws, low-passed)
    n = int(bar*SR*1.05); tt = np.arange(n)/SR; pad = np.zeros(n)
    for m in ch:
        for det in (-0.12, 0.12):
            ph = (f(m)*2**(det/12)*tt) % 1; pad += (2*ph-1)
    pad = lp(pad, 1400) * env(n, .25, .4, .7, .6, bar*SR/SR*0.92) * 0.035
    add(pad, t, .9, 1.0)
    # bass: root on 1 and 3, octave on the "and" of 4
    for k, (off, mm) in enumerate([(0, bass[b%4]), (2*BEAT, bass[b%4]), (3.5*BEAT, bass[b%4]+12)]):
        n2 = int(BEAT*1.6*SR); t2 = np.arange(n2)/SR
        s = np.sin(2*np.pi*f(mm)*t2) + .3*np.sin(4*np.pi*f(mm)*t2)
        add(s*env(n2, .005, .15, .6, .12, BEAT*1.2)*0.16, t+off)
    # plucky arpeggio, 8ths, from bar 2 on
    if b >= 1:
        pat = [0,1,2,3,2,1,2,3]
        for k, ix in enumerate(pat):
            m = ch[ix] + 12; n3 = int(.35*SR); t3 = np.arange(n3)/SR
            s = np.sign(np.sin(2*np.pi*f(m)*t3))*0.5 + np.sin(2*np.pi*f(m)*t3)
            s = lp(s, 3200) * np.exp(-t3*9) * 0.045
            add(s, t + k*BEAT/2, 1.0 if k%2 else .75, .75 if k%2 else 1.0)
    # drums from bar 1 (kick 1&3, clap 2&4, hats 8ths)
    if b >= 1:
        for q in range(4):
            tq = t + q*BEAT
            if q in (0, 2) or (q == 3 and b % 2):
                n4 = int(.3*SR); t4 = np.arange(n4)/SR
                fr = 50 + 90*np.exp(-t4*30); kick = np.sin(2*np.pi*np.cumsum(fr)/SR)*np.exp(-t4*9)*0.42
                add(kick, tq if q != 3 else tq + BEAT/2)
            if q in (1, 3):
                n5 = int(.22*SR); t5 = np.arange(n5)/SR
                clap = hp(rng.standard_normal(n5), 900)*np.exp(-t5*22)*0.09
                add(clap, tq, .9, 1.0)
        for e in range(8):
            n6 = int(.06*SR); t6 = np.arange(n6)/SR
            hat = hp(rng.standard_normal(n6), 7000)*np.exp(-t6*60)*(0.05 if e % 2 else 0.03)
            add(hat, t + e*BEAT/2, .8 if e%2 else 1.0, 1.0 if e%2 else .8)
mix = np.stack([L, R], 1)
# fades
fi = int(.6*SR); fo = int(2.5*SR)
mix[:fi] *= np.linspace(0, 1, fi)[:, None]; mix[-fo:] *= np.linspace(1, 0, fo)[:, None]
mix = np.tanh(mix*1.4)/np.tanh(1.4)  # gentle glue
mix /= np.max(np.abs(mix)) + 1e-9; mix *= 0.85
wavfile.write(OUT, SR, (mix*32767).astype(np.int16)); print("wrote", OUT)
