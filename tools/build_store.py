#!/usr/bin/env python3
"""Builds the public store pages (home, 4 product pages, gaming) from one template."""
import sys, html, json, os
OUT = sys.argv[1]
PRICE = {"review-feedback":"₹299","loyalty-card":"₹199","staff-attendance":"₹299","qr-menu-6":"₹249"}
IMG = json.load(open(os.path.join(os.path.dirname(__file__), "images.json"))) if os.path.exists(os.path.join(os.path.dirname(__file__), "images.json")) else {}

ICON = {
 "rev": '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.8l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.6l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
 "loy": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="3"/><circle cx="8" cy="12.5" r="1.6" fill="currentColor"/><circle cx="12" cy="12.5" r="1.6" fill="currentColor"/><circle cx="16" cy="12.5" r="1.6"/></svg>',
 "stf": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
 "qr": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5"/><path d="M14 14h3v3h-3zM17.5 17.5h3v3h-3z" fill="currentColor" stroke="none"/></svg>',
 "game": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12a4 4 0 0 1 3.9 4.8l-1 4.6a2.3 2.3 0 0 1-4 1L15 16H9l-1.9 2.4a2.3 2.3 0 0 1-4-1l-1-4.6A4 4 0 0 1 6 8z"/><path d="M8 11v3M6.5 12.5h3"/><circle cx="16" cy="12" r=".8" fill="currentColor"/></svg>',
 "check": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
}

P = {
 "rev": dict(cls="p-rev", file="reviews.html", slug="review-feedback", name="Review & Feedback", short="More 5-star Google reviews",
   tile="Happy customers post on Google. Unhappy ones talk to you first.",
   h1="More 5-star Google reviews, without asking twice.",
   lede="Customers scan a QR at your counter and rate their visit. Happy customers get a ready-written Google review to post in one tap. Unhappy ones send their complaint privately to you, so you can fix it before it reaches Google.",
   ticks=["<b>Review QR</b> for the counter, tables and bills", "<b>AI writes the review</b> in the customer's own words, they just tap Post", "<b>Complaints come to you</b> in a private inbox, not on Google"],
   feats=[("Review QR & counter screen","Print the QR or show it on a counter screen with your live Google rating."),("Ready-written reviews","AI suggests a review from what the customer liked, in English or Hindi. They edit or post as is."),("Private complaint inbox","1 to 3 stars go to you, with the customer's number so you can call and sort it out."),("Customer list","Every review also saves the customer's name, number and visit, so you can invite them back."),("Thank-you on WhatsApp","Send a thank-you or a small coupon to everyone who left a review."),("Rating report","See your rating and review count grow week by week.")],
   how=[("Put the QR on your counter","We send you a printable QR and a counter screen link on day one."),("Customer scans and rates","It takes 20 seconds, no app to download."),("Good ratings go to Google","Happy customers post the ready-written review. Bad ones come to your inbox.")],
   who=["Cafés & restaurants","Salons & spas","Clinics & dentists","Gyms","Shops & showrooms","Hotels"],
   faq=[("Is this allowed by Google?","Yes. Every customer is asked for feedback. We never block or hide a review, and the customer always chooses what to post."),("Do I need a Google Business Profile?","Yes, to receive Google reviews. If you don't have one, we can set it up for you."),("Can I reply to Google reviews from here?","Auto-replies to Google reviews are part of the Pro plan or a ₹149/month add-on.")],
   bundle="Get Review & Feedback with the Loyalty Card and daily alerts in the Basic plan for ₹499/month."),
 "loy": dict(cls="p-loy", file="loyalty-card.html", slug="loyalty-card", name="Loyalty Card", short="Customers come back more",
   tile="A stamp card on their phone that never gets lost.",
   h1="A loyalty card your customers never lose.",
   lede="Replace paper stamp cards with a digital card on the customer's phone. Scan to add a stamp, set the reward, and the app reminds customers when they're close to a free item.",
   ticks=["<b>Scan to stamp</b> in 2 seconds at the counter", "<b>Rewards you choose</b>, like a free coffee on the 10th visit", "<b>Birthday and festival coupons</b> that bring people back"],
   feats=[("Digital stamp card","Opens on the customer's phone from a link. No app, no paper, nothing to lose."),("Rewards at the visits you choose","10% off on visit 1, free item on visit 10. Change it any time."),("Coupons","Birthday, festival and win-back coupon codes, checked at the counter so they're used once."),("Customer list","Every stamp saves the visit, spend and birthday. See your regulars at a glance."),("Reminders","Optional WhatsApp reminders when a reward is close or a coupon is ending (credits extra)."),("Works for any business","Cafés, salons, gyms, clinics and shops all use the same simple card.")],
   how=[("Set your reward","Choose what customers get and after how many visits."),("Scan at the counter","Staff scan the customer's card or type their number. Stamp added."),("Customers come back","They see how close they are to the reward, and you see who your regulars are.")],
   who=["Cafés","Bakeries & sweet shops","Salons","Gyms","Pharmacies","Retail shops"],
   faq=[("Do customers need to download an app?","No. The card opens from a link or QR in their phone's browser, and can be saved to the home screen."),("Can staff add stamps?","Yes. Give each staff member their own login with only the permissions they need."),("Can I send offers on WhatsApp?","Yes. Reminders and coupons can go out on WhatsApp. Messages use WhatsApp credits.")],
   bundle="Get the Loyalty Card with Review & Feedback and daily alerts in the Basic plan for ₹499/month."),
 "stf": dict(cls="p-stf", file="staff-attendance.html", slug="staff-attendance", name="Staff Attendance & Salary", short="Attendance and salary, done",
   tile="Check-in with a PIN. Salary slips worked out for you.",
   h1="Staff attendance and salary, worked out for you.",
   lede="Staff check in and out with their PIN on the shop phone. Late marks, leave, advances and tips are counted automatically, and salary slips are ready at the end of the month.",
   ticks=["<b>PIN check-in</b> on the shop phone or tablet", "<b>Late marks, half days and leave</b> counted for you", "<b>Salary slips</b> with advances and tips, every month"],
   feats=[("PIN check-in","Each staff member checks in and out with their own PIN. No buddy punching."),("Late and leave","Set shift times. Late minutes, half days and leave are marked automatically."),("Advances","Record advances and loans. They're taken off the salary on the right month."),("Tips split your way","Split tips equally, by hours, or by role."),("Salary slips","Monthly salary worked out from attendance, ready to share on WhatsApp."),("Staff logins","Give managers their own login with only the permissions they need.")],
   how=[("Add your staff","Name, salary and shift time. Takes a minute each."),("They check in with a PIN","On the shop phone, every day, in and out."),("Salary at month end","Open Salary and share each slip. Done.")],
   who=["Restaurants","Salons & spas","Clinics","Retail shops","Gyms","Any team of 2 to 200"],
   faq=[("Does each staff member need a smartphone?","No. They check in on one shared phone or tablet at the shop, with their PIN."),("Can I set different shifts?","Yes. Each staff member can have their own shift time and weekly off."),("Is my staff's salary private?","Yes. Only the owner and people you allow can see salary.")],
   bundle="Get Staff Attendance with reviews, loyalty and SEO tools in the Growth plan for ₹899/month."),
 "qr": dict(cls="p-qr", file="qr-menu.html", slug="qr-menu-6", name="QR Menu", short="Menu and table orders",
   tile="Guests scan, order and you see it on the kitchen board.",
   h1="A QR menu that takes orders at every table.",
   lede="Guests scan the QR on their table to see your menu with photos and order straight from their phone. Orders appear on your kitchen board with the table number. Change prices or hide sold-out items in seconds.",
   ticks=["<b>A QR for every table</b>, ready to print", "<b>Orders go to the kitchen board</b> with the table number", "<b>Change prices any time</b>, no reprinting menus"],
   feats=[("Menu with photos","Add items with photos, prices and veg/non-veg tags. Upload your whole menu from Excel."),("QR per table","Every table gets its own QR, so you always know where the order came from."),("Kitchen board","New orders pop up on the kitchen screen with a sound. Mark them ready and served."),("Sold out in one tap","Hide an item when it runs out. Bring it back when it's ready."),("Counter & takeaway QR","A QR for the counter and the door for takeaway orders."),("₹249 per 6 tables","Small café or big restaurant, you only pay for the tables you have.")],
   how=[("Upload your menu","Type it in or upload an Excel file. We can do it for you."),("Print the table QRs","Download all QR codes at once and stick them on your tables."),("Take orders","Guests order from their phone. The kitchen board shows every order.")],
   who=["Cafés","Restaurants","Bakeries","Hotels & homestays","Food courts","Cloud kitchens"],
   faq=[("How is the price worked out?","₹249 a month for up to 6 tables. 7 to 12 tables is ₹498, 13 to 18 is ₹747, and so on: ₹249 for every 6 tables."),("Do guests need an app?","No. They scan the QR with their phone camera and the menu opens in the browser."),("Can guests pay from the menu?","Guests order from the menu and pay at the counter as usual.")],
   bundle="The Pro plan includes the QR Menu for 6 tables, plus every other tool, for ₹1,699/month."),
}
ORDER = ["rev", "loy", "stf", "qr"]

def phone(k):
    if k == "rev":
        s = '''<div class="bizhead"><div class="bizlogo">C</div><div><b>Chai Point Café</b><div class="sub">MG Road, Nagpur</div></div></div>
<h4 style="margin-top:6px">How was your visit today?</h4><div class="stars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
<div class="bubble">We wrote this for you, edit if you like:<br><b>“Loved the masala chai and the quick service. Staff were really friendly. Will come again!”</b></div>
<div class="sbtn b">Post on Google</div><div class="sub" style="text-align:center">Not happy? Tell the owner privately</div>
<div class="kpis" style="margin-top:auto"><div><b>4.8 ★</b><span>Google rating</span></div><div><b>+46</b><span>New reviews this month</span></div></div>'''
    elif k == "loy":
        s = '''<div class="sub">Hi Priya</div><h4>Your loyalty card</h4>
<div class="stamp-card"><b style="font-size:15px">Chai Point Café</b><div class="sub">7 of 10 visits</div>
<div class="stamps" aria-hidden="true">''' + '<i class="on">★</i>' * 7 + '<i></i><i></i><i class="gift">🎁</i></div></div>' + '''
<div class="bubble">3 more visits for a <b>free cold coffee</b></div>
<div class="bubble" style="display:flex;justify-content:space-between;align-items:center"><span>Birthday coupon<br><b>BDAY20 · 20% off</b></span><span class="tag-s t-ok">Valid</span></div>
<div class="sbtn" style="margin-top:auto">Show at the counter</div>'''
    elif k == "stf":
        rows = [("RK","#2f6bc4","Ravi Kumar","In 9:02 am","t-ok","On time"),("SN","#e5232b","Sunita Naik","In 9:18 am","t-late","18 min late"),("AM","#7c869f","Amit More","Leave today","t-off","Leave"),("PS","#5fa834","Pooja Shah","In 8:55 am","t-ok","On time")]
        s = '''<div class="sub">Today · Tuesday</div><h4>Staff attendance</h4><div class="kpis"><div><b>10</b><span>Present</span></div><div><b>2</b><span>Late</span></div></div>''' + \
            "".join(f'<div class="listrow"><span class="av" style="background:{c}">{i}</span><div class="g"><b>{n}</b><span>{t}</span></div><span class="tag-s {cl}">{tag}</span></div>' for i,c,n,t,cl,tag in rows) + \
            '<div class="sbtn" style="margin-top:auto">Salary slips for June are ready</div>'
    else:
        items = [("🍵","#fff1d6","Masala chai","Strong, with ginger","₹40"),("🥪","#e6f4dc","Bombay sandwich","Grilled, with chutney","₹110"),("🍟","#fde8e9","Peri peri fries","Crispy and spicy","₹90"),("🧋","#e3f2fc","Cold coffee","With ice cream","₹130")]
        s = '''<div style="display:flex;justify-content:space-between;align-items:center"><span class="chip-s">Table 4</span><span class="sub">Chai Point Café</span></div><h4>What would you like?</h4>
<div class="tabs-s"><span class="on">All</span><span>Chai</span><span>Snacks</span><span>Desserts</span></div>''' + \
            "".join(f'<div class="menu-it"><span class="ph" style="background:{bg}">{e}</span><div class="g"><b>{n}</b><span>{d}</span><div><em>{p}</em></div></div><span class="add-s"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span></div>' for e,bg,n,d,p in items) + \
            '<div class="cartbar"><span>2 items · ₹220</span><span>Send to kitchen</span></div>'
    return f'<div class="phone" aria-hidden="true"><div class="screen"><div class="sbar"><span>9:41</span><span>●●● 5G</span></div><div class="sc">{s}</div></div></div>'

def stage(k):
    ph = IMG.get(k)
    if ph:
        return f'<div class="stage has-photo"><img class="photo" src="{ph}" alt="" loading="lazy">{phone(k)}</div>'
    return f'<div class="stage">{phone(k)}</div>'

FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Figtree:wght@400;500;600;700;800&display=swap" rel="stylesheet">'

def head(title, desc, theme="#ffffff"):
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}">
<meta property="og:title" content="{html.escape(title)}"><meta property="og:description" content="{html.escape(desc)}"><meta property="og:image" content="https://scale.branditudeglobal.com/assets/img/branditude-logo.png">
<meta name="theme-color" content="{theme}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" href="/assets/icons/favicon-64.png">
<link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Branditude">
<script src="/assets/js/pwa.js" defer></script>
{FONTS}
<link rel="stylesheet" href="/assets/css/store.css?v=1">
</head>'''

def header(cur=""):
    menu = "".join(f'<a href="/{P[k]["file"]}" class="{P[k]["cls"]}"{" aria-current=page" if cur==k else ""}><span class="dot" style="background:var(--soft);color:var(--cd)">{ICON[k]}</span><span><b>{P[k]["name"]}</b><span>{P[k]["short"]} · from <span data-price="{P[k]["slug"]}">{PRICE[P[k]["slug"]]}</span>/month</span></span></a>' for k in ORDER)
    return f'''<a class="skip" href="#main">Skip to content</a>
<header class="top" id="topbar"><div class="wrap">
  <a class="brand" href="/"><img src="/assets/img/branditude-mark.svg" alt="" width="40" height="35"><span>Branditude<small>Growth tools for local business</small></span></a>
  <nav class="nav" id="site-nav" aria-label="Main">
    <div class="drop"><button class="navbtn" type="button" aria-expanded="false">Products ▾</button><div class="drop-menu">{menu}</div></div>
    <a href="/#plans">Plans</a><a href="/gaming.html"{" aria-current=page" if cur=="game" else ""}>Gaming clubs</a><a href="/#faq">FAQ</a><a href="/login.html" data-signin>Login</a>
  </nav>
  <div class="actions"><a class="btn primary sm hide-m" href="/#plans">See prices</a><button class="menu-btn" id="menu-btn" type="button" aria-label="Menu" aria-expanded="false" aria-controls="site-nav"><span></span></button></div>
</div></header>'''

def footer():
    prods = "".join(f'<a href="/{P[k]["file"]}">{P[k]["name"]}</a>' for k in ORDER)
    return f'''<footer><div class="wrap">
  <div><img class="flogo" src="/assets/img/branditude-logo-light.png" alt="Branditude, correct attitude for your brand" width="150" height="101"><p>Simple growth tools for cafés, salons, clinics, gyms and shops across India.</p><p data-year style="margin-top:14px"></p></div>
  <div><b>Products</b>{prods}<a href="/gaming.html">Gaming club software</a></div>
  <div><b>Company</b><a href="/#plans">Plans & prices</a><a href="/#faq">FAQ</a><a href="/#contact">Contact</a><a href="/privacy.html">Privacy policy</a></div>
  <div><b>Already a client?</b><a href="/login.html" data-signin>Login to dashboard</a><a href="#" data-install>Install the app</a><a href="/download/BranditudeGrowth-Windows.zip">Windows app</a></div>
</div></footer>
<div id="checkout-root"></div>
<script type="module" src="/assets/js/store.js?v=1"></script>
</body>
</html>'''

def faq(items):
    return "".join(f'<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>' for q, a in items)

CONTACT = '''<section class="contact" id="contact"><div class="wrap">
  <div><h2>Not sure what you need?</h2><p class="lede" style="margin-top:16px">Tell us about your business on WhatsApp. We'll suggest the right product or plan and set it up with you. We usually reply within an hour in working hours.</p>
  <div class="row-cta"><a class="btn wa" data-wa="Hi Branditude, I'd like to know which product fits my business." href="#contact" target="_blank" rel="noopener">Chat on WhatsApp</a><a class="btn line" href="/#plans">Compare plans</a></div></div>
  <div class="cinfo" data-cinfo></div></div></section>'''

def home():
    tiles = "".join(f'<a class="pick {P[k]["cls"]}" href="/{P[k]["file"]}"><span class="dot">{ICON[k]}</span><b>{P[k]["name"]}</b><span>{P[k]["tile"]}</span><i>From <span data-price="{P[k]["slug"]}">{PRICE[P[k]["slug"]]}</span>/month</i></a>' for k in ORDER)
    rows = ""
    for i, k in enumerate(ORDER):
        p = P[k]
        ticks = "".join(f"<li><span>{t}</span></li>" for t in p["ticks"])
        rows += f'''<div class="prod {p["cls"]}{" flip" if i % 2 else ""}" id="{p["slug"]}">{stage(k)}
  <div><span class="kicker"><span class="dot" style="background:var(--c);color:#fff;width:32px;height:32px;border-radius:10px">{ICON[k]}</span>{p["name"]}</span>
  <h2>{p["h1"]}</h2><p class="lede" style="margin-top:16px">{p["lede"]}</p><ul class="ticks">{ticks}</ul>
  <div class="price-line"><b class="num" data-price="{p["slug"]}">{PRICE[p["slug"]]}</b><span data-per>/month</span>{"<span>for up to 6 tables</span>" if k=="qr" else ""}</div>
  <div class="row-cta"><button class="btn primary" data-buy="{p["slug"]}">Buy {p["name"]}</button><a class="btn line" href="/{p["file"]}">See how it works</a></div></div></div>'''
    body = f'''<body data-page="home">
{header()}
<main id="main">
<section class="hero"><div class="wrap">
  <div><h1>Everything your shop needs to grow, from ₹199 a month.</h1>
  <p class="lede">Get more Google reviews, bring customers back with a digital loyalty card, track staff attendance and salary, and take orders from a QR menu. Buy just the one you need, or save with a plan.</p>
  <div class="cta"><a class="btn primary" href="#products">Pick a product</a><a class="btn line" href="#plans">See plans</a></div>
  <p class="trust"><span>{ICON["check"]}Set up for you in 48 hours</span><span>{ICON["check"]}Pay monthly, cancel any month</span><span>{ICON["check"]}UPI, cards & netbanking</span><span data-trial hidden></span></p></div>
  <div><p class="picker-h">Choose what you need</p><div class="picker">{tiles}</div></div>
</div></section>

<section id="products" style="padding-top:24px"><div class="wrap">
  <div class="sec-head"><h2>Four tools. Buy one, or all of them.</h2><p class="lede">Each one works on its own, on any phone. Start with the one that matters most to you today.</p></div>
  {rows}
</div></section>

<section style="padding-top:0"><div class="wrap">
  <div class="sec-head"><h2>Up and running in two days</h2></div>
  <div class="steps"><div class="step"><h3>Choose and pay online</h3><p>Pick a product or plan and pay by UPI, card or netbanking. It takes two minutes.</p></div>
  <div class="step"><h3>We set it up with you</h3><p>Our team adds your logo, menu, staff and rewards, and sends you the QR codes to print.</p></div>
  <div class="step"><h3>Start using it</h3><p>Put the QR on your counter. Everything runs from your dashboard on your phone.</p></div></div>
</div></section>

<section class="plans-sec" id="plans"><div class="wrap">
  <div class="sec-head c"><h2>Need more than one? A plan costs less.</h2><p class="lede" style="margin:16px auto 0">Plans bundle the tools together for less than buying them separately. Pay yearly and get 2 months free.</p>
  <div class="bill-toggle" role="group" aria-label="Billing"><button type="button" data-bill="monthly" aria-pressed="true">Monthly</button><button type="button" data-bill="yearly" aria-pressed="false">Yearly <em>2 months free</em></button></div></div>
  <div class="plans" data-plans="main"><p class="muted">Loading prices…</p></div>
  <div class="addons"><div class="head"><h3>Add anything to your plan</h3><p>Every tool can be added to a plan on its own, from Plan & services in your dashboard.</p></div><div class="ad-list" data-addons></div></div>
  <p class="gst-note" data-gst>Prices are in Indian rupees.</p>
</div></section>

<section class="gaming" id="gaming"><div class="wrap">
  <div class="sec-head"><span class="kicker" style="color:#9fe07a"><span class="dot" style="background:#7cc242;color:#10200a;width:32px;height:32px;border-radius:10px">{ICON["game"]}</span>For gaming clubs</span><h2>Run a gaming café? It has its own two plans.</h2><p class="lede" style="margin-top:16px">Live timers for every PS5, PC, VR and pool table, LP splits, happy-hour pricing, snacks and bills. Everything is included in the plan.</p></div>
  <div class="g-feats"><div><b>Live station timers</b><span>No double bookings, from any staff phone</span></div><div><b>LP (loser pays)</b><span>Split every game, bill each player</span></div><div><b>Happy hours</b><span>Prices by day and time, minute by minute</span></div><div><b>Bills & snacks</b><span>Cash, UPI, card, split or pay later</span></div></div>
  <div class="plans" data-plans="gaming"></div>
  <div class="row-cta"><a class="btn line" style="background:transparent;color:#fff;box-shadow:inset 0 0 0 1.5px #4a5577" href="/gaming.html">See everything for gaming clubs</a></div>
</div></section>

<section id="faq"><div class="wrap">
  <div class="sec-head"><h2>Questions owners ask us</h2></div>
  <div class="faq">{faq([
    ("Can I buy just one product?","Yes. Review & Feedback, Loyalty Card, Staff Attendance and QR Menu are each sold on their own. You can add more later or move to a plan any time."),
    ("Is there a contract?","No. Pay monthly and stop any month, or pay yearly and get 2 months free."),
    ("Who sets it up?","We do, with you. Within 48 hours we add your logo, menu, staff and rewards, and send you QR codes to print."),
    ("Do my customers need to download an app?","No. Customers scan a QR and everything opens in their phone's browser."),
    ("How do WhatsApp messages work?","Reminders and offers go out on WhatsApp from a verified business number. Messages use WhatsApp credits, which you top up in the app."),
    ("How do I pay?","Online through Razorpay: UPI (GPay, PhonePe, Paytm), debit or credit card, netbanking or wallets. It switches on as soon as you pay."),
    ("Is my customer data safe?","Your data is private to your business. We never message your customers unless you ask, and you can export or delete it any time.")])}</div>
</div></section>
{CONTACT}
</main>
<div class="mbar" id="mbar" aria-hidden="true"><a class="btn line" href="#plans">See prices</a><a class="btn wa" data-wa="Hi Branditude, I'd like to know more." href="#contact" target="_blank" rel="noopener">WhatsApp us</a></div>
{footer()}'''
    return head("Branditude · Reviews, loyalty card, staff attendance & QR menu for local business", "Get more Google reviews, a digital loyalty card, staff attendance & salary, and a QR menu with table orders. From ₹199/month. Set up for you in 48 hours.") + "\n" + body

def product(k):
    p = P[k]
    feats = "".join(f'<div class="feat {p["cls"]}"><span class="dot">{ICON[k]}</span><h3>{html.escape(t)}</h3><p>{html.escape(d)}</p></div>' for t, d in p["feats"])
    how = "".join(f'<div class="step"><h3>{html.escape(t)}</h3><p>{html.escape(d)}</p></div>' for t, d in p["how"])
    who = "".join(f"<span>{html.escape(w)}</span>" for w in p["who"])
    ticks = "".join(f"<li><span>{t}</span></li>" for t in p["ticks"])
    if k == "qr":
        buy = '''<div class="tables" data-tables><label id="tl">Your tables</label><div class="stepper" role="group" aria-labelledby="tl"><button type="button" data-tstep="-1" aria-label="Fewer tables">−</button><output data-tables-out>Up to 6 tables</output><button type="button" data-tstep="1" aria-label="More tables">+</button></div></div>
<div class="row"><div class="amt"><b class="num" data-tables-price>₹249</b> <span data-tables-per>/month</span></div><button class="btn primary" data-tables-buy data-buy="qr-menu-6">Get QR Menu</button></div>
<p class="note">₹249 a month for every 6 tables. Pay yearly and get 2 months free.</p>'''
    else:
        buy = f'''<div class="row"><div class="amt"><b class="num" data-price="{p["slug"]}">{PRICE[p["slug"]]}</b> <span data-per>/month</span></div><button class="btn primary" data-buy="{p["slug"]}">Buy {p["name"]}</button></div>
<p class="note">Pay monthly, cancel any month. Pay yearly and get 2 months free.</p>'''
    toggle = '<div class="bill-toggle" role="group" aria-label="Billing" style="margin:0 0 14px"><button type="button" data-bill="monthly" aria-pressed="true">Monthly</button><button type="button" data-bill="yearly" aria-pressed="false">Yearly <em>2 months free</em></button></div>'
    others = "".join(f'<a class="pick {P[o]["cls"]}" href="/{P[o]["file"]}"><span class="dot">{ICON[o]}</span><b>{P[o]["name"]}</b><span>{P[o]["tile"]}</span><i>From <span data-price="{P[o]["slug"]}">{PRICE[P[o]["slug"]]}</span>/month</i></a>' for o in ORDER if o != k)
    photo = IMG.get(k + "_wide")
    shot = f'<section style="padding-top:0"><div class="wrap"><figure style="margin:0;border-radius:28px;overflow:hidden"><img src="{photo}" alt="" loading="lazy" style="width:100%;aspect-ratio:16/7;object-fit:cover"></figure></div></section>' if photo else ""
    body = f'''<body data-page="product" class="{p["cls"]}">
{header(k)}
<main id="main">
<section class="phero {p["cls"]}"><div class="wrap">
  <div class="txt"><p class="crumbs"><a href="/">Home</a> / <a href="/#products">Products</a> / {p["name"]}</p>
  <span class="kicker"><span class="dot" style="background:var(--c);color:#fff;width:32px;height:32px;border-radius:10px">{ICON[k]}</span>{p["name"]}</span>
  <h1 style="font-size:clamp(38px,5.4vw,64px)">{p["h1"]}</h1><p class="lede" style="margin-top:18px">{p["lede"]}</p>
  <div class="buybox">{toggle}{buy}</div></div>
  {phone(k)}
</div></section>

<section class="after-hero {p["cls"]}"><div class="wrap">
  <div class="sec-head"><h2>What you get</h2><ul class="ticks">{ticks}</ul></div>
  <div class="feat-grid">{feats}</div>
</div></section>
{shot}
<section style="padding-top:0"><div class="wrap">
  <div class="sec-head"><h2>How it works</h2></div><div class="steps">{how}</div>
  <div style="margin-top:40px"><h3>Made for</h3><div class="who">{who}</div></div>
</div></section>

<section style="padding-top:0"><div class="wrap"><div class="bundle"><div><h2 style="font-size:clamp(26px,3vw,36px)">Want more than one tool?</h2><p>{p["bundle"]} Plans always cost less than buying the tools separately.</p></div>
  <div class="row-cta" style="margin:0"><a class="btn primary" href="/#plans">Compare plans</a><button class="btn line" data-buy="{p["slug"]}">Just {p["name"]}</button></div></div></div></section>

<section style="padding-top:0"><div class="wrap"><div class="sec-head"><h2>Questions about {p["name"]}</h2></div><div class="faq">{faq(p["faq"] + [("Who sets it up?","We do, with you, within 48 hours of payment."),("Can I cancel?","Yes. Monthly plans stop at the end of the month you've paid for.")])}</div></div></section>

<section style="padding-top:0"><div class="wrap"><div class="sec-head"><h2>Our other tools</h2></div><div class="picker" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">{others}</div></div></section>
{CONTACT}
</main>
<div class="mbar" id="mbar" aria-hidden="true"><button class="btn primary" data-buy="{p["slug"]}">Buy · <span data-price="{p["slug"]}">{PRICE[p["slug"]]}</span></button><a class="btn wa" data-wa="Hi Branditude, I'd like to know more about {p["name"]}." href="#contact" target="_blank" rel="noopener">WhatsApp</a></div>
{footer()}'''
    desc = f'{p["name"]} by Branditude: {p["tile"]} From ₹{ {"rev":299,"loy":199,"stf":299,"qr":249}[k] }/month, set up for you in 48 hours.'
    return head(f'{p["name"]} for your business · Branditude', desc) + "\n" + body

def gaming():
    feats = [("Live station timers","Start, pause, add time and move stations from any staff phone. No double bookings."),("LP (loser pays) matches","Player names, a split after every game, the winner noted, and each player's share on the bill."),("15-minute warning","Staff get a popup before booked time ends, with one-tap extend or a WhatsApp reminder."),("Happy hours & Sunday prices","Prices by day and time, worked out minute by minute, so a session across 4 pm is billed right."),("Snacks & stock","Drinks and snacks on the same bill, stock counted, low-stock alerts."),("Bills your way","Cash, UPI, card, split or pay later. Thermal and A4 bills with a UPI pay link.")]
    fg = "".join(f'<div class="feat"><span class="dot" style="background:#eaf6e1;color:#3d7a1c">{ICON["game"]}</span><h3>{t}</h3><p>{d}</p></div>' for t, d in feats)
    body = f'''<body data-page="gaming">
{header("game")}
<main id="main">
<section class="hero gaming" style="padding:72px 0 88px"><div class="wrap" style="grid-template-columns:1fr">
  <div><span class="kicker" style="color:#9fe07a"><span class="dot" style="background:#7cc242;color:#10200a;width:32px;height:32px;border-radius:10px">{ICON["game"]}</span>Gaming club software</span>
  <h1 style="color:#fff;max-width:16ch">Run your gaming café from one phone.</h1>
  <p class="lede" style="margin-top:20px">Live timers for every PS5, Xbox, PC, VR, racing sim and pool table. LP matches split game by game, happy-hour pricing, snacks and bills, all in one app. We set it up for you.</p>
  <div class="cta"><a class="btn primary" href="#gplans">See the 2 plans</a><a class="btn line" style="background:transparent;color:#fff;box-shadow:inset 0 0 0 1.5px #4a5577" data-wa="Hi Branditude, I'd like a demo of the Gaming Club software." href="#contact" target="_blank" rel="noopener">Get a demo on WhatsApp</a></div></div>
</div></section>
<section><div class="wrap"><div class="sec-head"><h2>Everything a gaming club runs on</h2></div><div class="feat-grid">{fg}</div></div></section>
<section class="gaming" id="gplans"><div class="wrap">
  <div class="sec-head"><h2>Two plans. Everything included.</h2><p class="lede" style="margin-top:16px">No add-ons to work out. Pick the plan that fits and you're done.</p>
  <div class="bill-toggle" role="group" aria-label="Billing"><button type="button" data-bill="monthly" aria-pressed="true">Monthly</button><button type="button" data-bill="yearly" aria-pressed="false">Yearly <em>2 months free</em></button></div></div>
  <div class="plans" data-plans="gaming"><p class="muted">Loading prices…</p></div>
  <p class="gst-note" data-gst style="color:#8d97b3"></p>
</div></section>
<section id="faq"><div class="wrap"><div class="sec-head"><h2>Questions from club owners</h2></div><div class="faq">{faq([
  ("Which stations does it support?","PS5, Xbox, PC, VR, racing sims, pool and snooker tables, or anything you charge by time."),
  ("Can staff use their own phones?","Yes. Each staff member gets a login with only the permissions they need."),
  ("What's the difference between the plans?","Game Club has everything to run the floor. Premium adds WhatsApp bills and reminders, loyalty cards, birthday offers and staff salary."),
  ("Is there a contract?","No. Pay monthly and stop any month, or pay yearly and get 2 months free.")])}</div></div></section>
{CONTACT}
</main>
<div class="mbar" id="mbar" aria-hidden="true"><a class="btn primary" href="#gplans">See plans</a><a class="btn wa" data-wa="Hi Branditude, I'd like a demo of the Gaming Club software." href="#contact" target="_blank" rel="noopener">WhatsApp</a></div>
{footer()}'''
    return head("Gaming club software: timers, LP billing & bookings · Branditude", "Live station timers, LP (loser pays) splits, happy-hour pricing, snacks and bills for gaming cafés. Two plans from ₹850/month.", "#0e1426") + "\n" + body

open(os.path.join(OUT, "index.html"), "w").write(home())
for k in ORDER: open(os.path.join(OUT, P[k]["file"]), "w").write(product(k))
open(os.path.join(OUT, "gaming.html"), "w").write(gaming())
print("built", OUT)
