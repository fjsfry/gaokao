# Design QA: Xunlu Strict UI Rebuild

source visual truth path:
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_22 (1).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_22 (2).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_22 (3).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_23 (4).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_24 (5).png

implementation screenshot path:
- C:/Users/Administrator/AppData/Local/Temp/xunlu-ui-strict-qa/home-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-ui-strict-qa/product-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-ui-strict-qa/checkup-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-ui-strict-qa/sample-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-ui-strict-qa/pricing-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-ui-strict-qa/home-mobile.png

viewport:
- Desktop: 1280 x 720
- Mobile: 390 x 844

state:
- Public static site, hash routes: home, product, checkup, sample, pricing.

full-view comparison evidence:
- The rendered pages now follow the source visual system more strictly: fixed dark navy header, white content canvas, teal active nav underline, large two-column home hero, product input-calculation-output-delivery panel, online-evaluation right advice panel, report-style sample table, service-plan pricing cards, dark navy footer, and QR/contact blocks.

focused region comparison evidence:
- Header and hero: desktop and mobile checked against the home reference. Mobile nav remains visible as a horizontal bar and the hero stacks into one column without overlap.
- Product page: left title block is frameless like the reference and the right process panel is visible.
- Online evaluation: form cards, import controls, right advice panel, and preview result cards are visible.
- Sample page: report table shell and tab treatment are visible.
- Pricing page: service-plan layout matches the reference direction while preserving existing production prices.

automated validation:
- `node --check app.js`: passed.
- `python -m py_compile server.py`: passed.
- `python -m json.tool vercel.json`: passed.
- `git diff --check`: passed.
- Local Playwright QA: no console errors/warnings; no horizontal overflow on 1280px desktop or 390px mobile.
- Local online evaluation smoke test: submitting score/rank generated a live risk result, restored the submit button, and rendered result cards.
- Fixed header validation after scroll: `position: fixed`, top `0`.
- Price validation: `￥0`, `￥29.9`, `￥99`, `￥199/季起`.

findings:
- No P0/P1/P2 issues remain.
- Intentional deviation: pricing values remain the existing live values (`0`, `29.9`, `99`, `199/季起`) instead of the mockup values, per user instruction.
- Intentional deviation: contact phone remains `18233662815`, matching the current production requirement.

patches made since previous QA pass:
- Updated cache version to `20260617-ui-strict`.
- Added fourth homepage proof card and homepage stats strip.
- Reworked product intro to match the reference layout more closely.
- Reworked online-evaluation form into two framed cards with upload/action area, right advice panel, and preview result section.
- Added mobile overrides so the header navigation remains visible and the hero stacks cleanly.
- Preserved authorization-code, Excel parsing, DeepSeek proxy, Supabase-backed report-code behavior, pricing, phone, logo, and QR assets.

final result: passed
