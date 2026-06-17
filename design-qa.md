# Design QA: Xunlu Tight Product UI

source visual truth path:
- https://www.seekoffer.com.cn/
- C:/Users/Administrator/AppData/Local/Temp/xunlu-tight-ui-reference/seekoffer-reference-home-clear.png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_22 (1).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_22 (2).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_22 (3).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_23 (4).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_24 (5).png

implementation screenshot path:
- C:/Users/Administrator/AppData/Local/Temp/xunlu-tight-ui-qa/home-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-tight-ui-qa/product-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-tight-ui-qa/checkup-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-tight-ui-qa/sample-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-tight-ui-qa/pricing-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-tight-ui-qa/license-admin-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-tight-ui-qa/home-mobile.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-tight-ui-qa/license-admin-mobile.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-volunteer-table-qa/home-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-volunteer-table-qa/checkup-desktop.png
- C:/Users/Administrator/AppData/Local/Temp/xunlu-volunteer-table-qa/checkup-mobile-table.png

viewport:
- Desktop: 1440 x 900
- Mobile: 390 x 844

state:
- Public static site, hash routes: home, product, checkup, sample, pricing, license-admin.

full-view comparison evidence:
- The rendered pages now follow the SeekOffer house style more closely: white fixed product navigation, refined logo badge, unified 1350px centered shell, calmer mint canvas, consistent card radii, lighter shadows, tighter vertical rhythm, and stable mobile navigation.

focused region comparison evidence:
- Header and logo: white navigation bar, pill active state, icon nav on desktop, text-only nav on mobile, and complete logo badge checked against SeekOffer.
- Homepage: hero is a centered rounded shell; first viewport now reveals the next section at 1440 x 900.
- Product/checkup/sample/pricing pages: main content containers align to the same centered shell and use consistent card styling.
- License admin: internal code generation page uses the same shell, form controls, card radius, button style, and mobile layout as public pages.
- Online volunteer entry: visible input is now a table editor with batch, school, major, add row, renumber, up, down, and delete controls; the hidden textarea remains only as the normalized compatibility payload for report generation.

automated validation:
- `node --check app.js`: passed.
- `python -m py_compile server.py`: passed.
- `python -m json.tool vercel.json`: passed.
- `git diff --check`: passed.
- Local Playwright QA: no console errors/warnings; no horizontal overflow on 1440px desktop or 390px mobile.
- Local license-admin interaction: submitting without an internal token focuses the password field and shows the expected validation message.
- Fixed header validation after scroll: `position: fixed`, top `0`.
- Mobile navigation validation: all five navigation items fit inside 390px without horizontal page overflow.
- Price validation: `￥0`, `￥29.9`, `￥99`, `￥199/季起`.
- Volunteer table QA: Browser plugin path passed page identity, nonblank DOM, no console errors/warnings, add row, fill row, move down, move up, hidden `#volunteers` sync, and report preview generation with 11 volunteers.
- Screenshot fallback: Browser screenshot capture timed out, so local Playwright saved the visual evidence listed above.
- Mobile volunteer table validation: 390px viewport uses block/card rows, no horizontal page overflow, and row actions remain visible.
- Homepage regression validation: app version `20260617-volunteer-table`; logo uses `object-fit: contain` and `transform: none`; home sections have no horizontal overflow.

findings:
- No P0/P1/P2 issues remain.
- Intentional deviation: pricing values remain the existing live values (`0`, `29.9`, `99`, `199/季起`) instead of the mockup values, per user instruction.
- Intentional deviation: contact phone remains `18233662815`, matching the current production requirement.

patches made since previous QA pass:
- Updated cache version to `20260617-volunteer-table`.
- Switched top navigation from dark bar to SeekOffer-style white product navigation with icons on desktop.
- Reworked logo presentation to show the complete existing brand asset.
- Added a final tight UI CSS layer for unified shell width, section spacing, cards, forms, buttons, footer, and mobile nav.
- Included the internal `#/license-admin` route in desktop and mobile visual QA.
- Preserved authorization-code, Excel parsing, DeepSeek proxy, Supabase-backed report-code behavior, pricing, phone, logo, and QR assets.
- Replaced visible raw volunteer textarea with a structured table editor while keeping upload parsing and existing report matching compatible through a hidden normalized field.

final result: passed
