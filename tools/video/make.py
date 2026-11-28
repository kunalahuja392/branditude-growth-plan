import re, json, html, os, sys
WEB="/home/claude/bgp2/web"
GAME_PHONE = ('<div class="phone" aria-hidden="true"><div class="screen"><div class="sbar"><span>9:41</span><span>●●● 5G</span></div><div class="sc">'
  '<div class="sub">Pixel Arena · Live board</div><h4>Stations</h4><div class="kpis"><div><b>₹6,420</b><span>Today\'s sales</span></div><div><b>5 / 8</b><span>Playing now</span></div></div>'
  + "".join(f'<div class="listrow"><span class="av" style="background:{c}">{i}</span><div class="g"><b>{n}</b><span>{t}</span></div><span class="tag-s {cl}">{tag}</span></div>' for i,c,n,t,cl,tag in
     [("P1","#2f6bc4","PS5-1 · LP match","Rahul vs Amit · 42 min","t-ok","₹160"),("P2","#7c3aed","PS5-2","1 hr booked · 12 min left","t-late","Ends soon"),("VR","#e5232b","VR Pod","Free","t-off","Start"),("PC","#5fa834","PC-3 · Happy hour","₹40/hr till 4 pm","t-ok","₹70")])
  + '<div class="sbtn" style="margin-top:auto">Bill PS5-1 · ₹160 · UPI</div></div></div></div>')
def phone_of(page):
    if page == "gaming.html": return GAME_PHONE
    s=open(f"{WEB}/{page}").read()
    i=s.find('<div class="phone"'); 
    if i<0: return ""
    # balance divs
    depth=0; j=i
    for m in re.finditer(r'<div\b|</div>', s[i:]):
        depth += 1 if m.group(0)=='<div' else -1
        if depth==0: j=i+m.end(); break
    return s[i:j]
V = {
 "reviews": dict(cls="p-rev", page="reviews.html", name="Review & Feedback", icon="★",
   hook="Happy customers forget to review.<br>Unhappy ones never forget.",
   intro="Customers rate their visit at your counter. Happy ones post on Google in one tap. Complaints come to you privately.",
   steps=[("Put the QR on your counter","We send you a printable QR and a counter screen."),("Customer scans and rates","20 seconds, no app to download."),("Good ratings go to Google","AI writes the review for them. Bad ratings come to your inbox.")],
   ticks=["More 5-star Google reviews","Complaints reach you first","Every customer saved to your list"],
   price="₹299", url="scale.branditudeglobal.com/reviews"),
 "loyalty-card": dict(cls="p-loy", page="loyalty-card.html", name="Loyalty Card", icon="●",
   hook="Paper stamp cards get lost.<br>Regulars stop coming back.",
   intro="A digital loyalty card on your customer's phone. Scan to add a stamp, and they come back for the reward.",
   steps=[("Set your reward","For example: 10th coffee free, or 20% off on the 5th visit."),("Scan at the counter","Each visit adds a stamp. No app for customers."),("Customers come back","WhatsApp reminders when they're close to a reward, plus birthday coupons.")],
   ticks=["Customers come back more often","Birthday coupons on autopilot","See who your regulars are"],
   price="₹199", url="scale.branditudeglobal.com/loyalty-card"),
 "staff-attendance": dict(cls="p-stf", page="staff-attendance.html", name="Staff Attendance & Salary", icon="◷",
   hook="Registers, late marks and<br>salary maths every month?",
   intro="Staff check in with a PIN on your counter tablet. You see attendance live, and salary is worked out for you.",
   steps=[("Add your staff","Name, salary and shift timings. Takes 5 minutes."),("They check in with a PIN","Late marks and leave are recorded automatically."),("Salary is worked out","Advances and late cuts included. Slips ready every month.")],
   ticks=["Live attendance on your phone","No more salary arguments","Advances and leave tracked"],
   price="₹299", url="scale.branditudeglobal.com/staff-attendance"),
 "qr-menu": dict(cls="p-qr", page="qr-menu.html", name="QR Menu", icon="▦",
   hook="Printed menus get old.<br>Waiters run between tables.",
   intro="Guests scan the QR on their table, see your menu with photos, and order straight to your kitchen.",
   steps=[("Upload your menu","Dishes, photos and prices. Change them any time."),("Guests scan and order","From their own phone. No app to download."),("Kitchen gets the order","With the table number, the moment it's placed.")],
   ticks=["Update prices in seconds","Hide sold-out dishes","Fewer order mistakes"],
   price="₹249", per="/month for up to 6 tables", url="scale.branditudeglobal.com/qr-menu"),
 "gaming": dict(cls="p-game", page="gaming.html", name="Gaming Club software", icon="🎮", dark=True,
   hook="Paper timers, LP arguments<br>and missed bills?",
   intro="Run your gaming café from one phone: live timers, LP splits, happy-hour prices, snacks and bills.",
   steps=[("Start a station","PS5, PC, VR or pool table. The timer runs live on every staff phone."),("Play and split LP","Each game's loser is noted, and every player's share goes on the bill."),("Bill in one tap","Time, snacks and happy-hour prices added up. Cash, UPI or card.")],
   ticks=["No double bookings","15-minute warnings for staff","Daily sales report"],
   price="₹850", price2="Premium ₹1,500/month", url="scale.branditudeglobal.com/gaming"),
 "restaurant-app": dict(cls="p-rest", page="restaurant-app.html", name="Restaurant app + Porter", icon="🛵",
   hook="Paying 20–30% commission<br>on every delivery order?",
   intro="Your own food ordering app. Orders come to you, and a Porter rider is booked automatically.",
   steps=[("Customer orders from your app","From your link or QR. They pick dishes and pay."),("You accept the order","It rings on your phone or tablet. Tap accept and cook."),("Porter delivers automatically","A rider is booked when food is ready, with live tracking on WhatsApp.")],
   ticks=["0% commission on your orders","Your brand, your customers","Delivery & payment charges as actual"],
   price="₹1,499", pre="Starting", url="scale.branditudeglobal.com/restaurant-app", demo=True),
}
CSS = open(f"{WEB}/assets/css/store.css").read()
def build(key, v):
    ph = phone_of(v["page"])
    dark = v.get("dark")
    D = v.get('D') or [3.6,4.6,4.4,4.4,4.4,4.6,5.4]
    T = [sum(D[:i]) for i in range(len(D))]; total=sum(D)
    def sc(i, inner, extra=""):
        return f'<section class="scene {extra}" style="animation:scene {D[i]}s linear {T[i]}s both">{inner}</section>'
    def rise(i, off, inner, tag="div", cls=""):
        return f'<{tag} class="r {cls}" style="animation:rise .7s cubic-bezier(.2,.8,.2,1) {T[i]+off:.2f}s both">{inner}</{tag}>'
    steps = ""
    for n,(t,d) in enumerate(v["steps"]):
        i=2+n
        dots = "".join(f'<i class="{"on" if m<=n else ""}"></i>' for m in range(3))
        steps += sc(i, f'''<div class="split">
          <div class="tx">{rise(i,.1,f'<span class="num">{n+1}</span><span class="dots">{dots}</span>')}{rise(i,.25,t,"h2")}{rise(i,.45,d,"p","lede2")}</div>
          <div class="ph">{rise(i,.15,ph,"div","phwrap step"+str(n))}</div></div>''')
    ticks = "".join(f'<li class="r" style="animation:rise .6s cubic-bezier(.2,.8,.2,1) {T[5]+.35+k*.35:.2f}s both"><span>✓</span>{t}</li>' for k,t in enumerate(v["ticks"]))
    price_line = (f'<span class="pre">{v["pre"]}</span>' if v.get("pre") else "") + f'<b>{v["price"]}</b><span class="per">{v.get("per","/month")}</span>'
    end_sub = ("Book a free demo on WhatsApp" if v.get("demo") else "Try it free for 3 days")
    body = (
      sc(0, f'<div class="center">{rise(0,.15,v["hook"],"h1","hook")}</div>', "hookbg") +
      sc(1, f'''<div class="split"><div class="tx">{rise(1,.1,f'<span class="badge">{v["icon"]}</span>{v["name"]}',"div","kick")}{rise(1,.3,v["intro"],"p","lede1")}</div>
               <div class="ph">{rise(1,.25,ph,"div","phwrap")}</div></div>''') +
      steps +
      sc(5, f'<div class="center"><h2 class="r" style="animation:rise .6s cubic-bezier(.2,.8,.2,1) {T[5]+.1:.2f}s both">What you get</h2><ul class="ticks2">{ticks}</ul></div>') +
      sc(6, f'''<div class="center end">{rise(6,.1,'<img src="file:///home/claude/bgp2/web/assets/img/branditude-mark.svg" width="70">Branditude',"div","brand2")}
               {rise(6,.3,v["name"],"div","pname")}{rise(6,.45,price_line,"div","price")}
               {rise(6,.6,v.get("price2",""),"div","price2") if v.get("price2") else ""}
               {rise(6,.8,end_sub,"div","pill")}{rise(6,1.0,v["url"],"div","url")}{rise(6,1.15,"WhatsApp +91 88558 37148","div","wa")}</div>''', "endbg"))
    c = "#f26b1d" if v["cls"]=="p-rest" else ("#7cc242" if dark else None)
    page = f'''<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:"Bricolage Grotesque";src:url("file:///mnt/skills/examples/canvas-design/canvas-fonts/BricolageGrotesque-Bold.ttf");font-weight:700 800}}
{CSS}
:root{{--display:"Bricolage Grotesque",Inter,sans-serif;--body:Inter,sans-serif}}
html,body{{margin:0;width:1280px;height:720px;overflow:hidden;background:{"#0e1426" if dark else "var(--soft)"}}}
body.p-game{{--c:#7cc242;--cd:#9fe07a;--soft:#0e1426}}
body.p-rest{{--c:#f26b1d;--cd:#b44a0c;--soft:#fff1e8}}
.scene{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:0 90px;box-sizing:border-box}}
.hookbg{{background:var(--c);color:#fff}} .endbg{{background:{"#0e1426" if dark else "#fff"}}}
@keyframes scene{{0%{{opacity:0}}6%{{opacity:1}}94%{{opacity:1}}100%{{opacity:0}}}}
@keyframes rise{{from{{opacity:0;transform:translateY(28px)}}to{{opacity:1;transform:none}}}}
.center{{text-align:center;width:100%}}
h1.hook{{font:800 64px/1.1 var(--display);letter-spacing:-.03em;color:#fff;margin:0}}
.split{{display:grid;grid-template-columns:1.15fr .85fr;gap:40px;align-items:center;width:100%}}
.tx{{color:{"#fff" if dark else "var(--ink)"}}}
.kick{{font:800 46px/1.1 var(--display);letter-spacing:-.03em;display:flex;align-items:center;gap:16px}}
.badge{{width:62px;height:62px;border-radius:18px;background:var(--c);color:#fff;display:grid;place-items:center;font-size:30px}}
.lede1{{font:500 28px/1.45 var(--body);color:{"#c7cee0" if dark else "var(--ink-2)"};margin-top:22px;max-width:30ch}}
.num{{display:inline-grid;place-items:center;width:64px;height:64px;border-radius:20px;background:var(--c);color:#fff;font:800 34px var(--display)}}
.dots{{display:inline-flex;gap:8px;margin-left:18px;vertical-align:middle}} .dots i{{width:44px;height:8px;border-radius:9px;background:{"#2a3450" if dark else "rgba(0,0,0,.1)"}}} .dots i.on{{background:var(--c)}}
.tx h2{{font:800 52px/1.08 var(--display);letter-spacing:-.03em;margin:26px 0 0;color:inherit}}
.lede2{{font:500 28px/1.45 var(--body);color:{"#c7cee0" if dark else "var(--ink-2)"};margin-top:18px;max-width:28ch}}
.ph{{display:flex;justify-content:center}} .phwrap .phone{{margin:0!important;transform:scale(1);transform-origin:center}}
.phwrap.step1 .phone{{transform:scale(1) rotate(-3deg)}} .phwrap.step2 .phone{{transform:scale(1) rotate(3deg)}}
.center h2{{font:800 60px var(--display);letter-spacing:-.03em;color:{"#fff" if dark else "var(--ink)"};margin:0 0 30px}}
.ticks2{{list-style:none;padding:0;margin:0 auto;display:inline-flex;flex-direction:column;gap:18px;text-align:left}}
.ticks2 li{{font:700 36px var(--body);color:{"#fff" if dark else "var(--ink)"};display:flex;gap:18px;align-items:center}}
.ticks2 li span{{width:50px;height:50px;border-radius:50%;background:var(--c);color:#fff;display:grid;place-items:center;font-size:28px}}
.brand2{{display:inline-flex;align-items:center;gap:14px;font:800 40px var(--display);color:{"#fff" if dark else "var(--ink)"}}}
.pname{{font:700 30px var(--body);color:{"#c7cee0" if dark else "var(--ink-2)"};margin-top:18px}}
.price{{margin-top:6px;color:{"#fff" if dark else "var(--ink)"}}} .price b{{font:800 108px var(--display);letter-spacing:-.04em}} .price .per{{font:600 30px var(--body);color:{"#8d97b3" if dark else "var(--ink-3)"};margin-left:8px}} .price .pre{{font:700 30px var(--body);color:var(--ink-3);margin-right:12px}}
.price2{{font:700 30px var(--body);color:var(--cd);margin-top:-4px}}
.pill{{display:inline-block;margin-top:18px;background:var(--c);color:#fff;font:800 30px var(--body);padding:12px 28px;border-radius:999px}}
.url{{font:700 30px var(--body);color:{"#fff" if dark else "var(--ink)"};margin-top:22px}} .wa{{font:700 26px var(--body);color:#1f9d55;margin-top:8px}}
</style></head><body class="{v["cls"]}">{body}</body></html>'''
    open(f"/home/claude/vid/{key}.html","w").write(page)
    return total
import subprocess
VO=os.path.join(os.path.dirname(os.path.abspath(__file__)),'voice')
base=[3.6,4.6,4.4,4.4,4.4,4.6,5.4]
for k,v in V.items():
    ds=[float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',f'{VO}/{k}_{i}.mp3']).decode()) for i in range(7)]
    v['D']=[round(max(base[i], ds[i]+0.75),2) for i in range(7)]
    v['VOD']=ds
tot={k:build(k,v) for k,v in V.items()}
json.dump({k:v['D'] for k,v in V.items()}, open('/home/claude/vid/scenes.json','w'))
json.dump(tot, open("/home/claude/vid/durations.json","w")); print(tot)
