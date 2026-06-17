# Design QA: Xunlu UI Refresh

source visual truth path:
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_22 (1).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_22 (2).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_22 (3).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_23 (4).png
- D:/图片/志愿网站/最新UI/ChatGPT Image 2026年6月17日 08_33_24 (5).png

implementation screenshot path:
- C:/Users/ADMINI~1/AppData/Local/Temp/xunlu-ui-refresh-qa/home-desktop.png
- C:/Users/ADMINI~1/AppData/Local/Temp/xunlu-ui-refresh-qa/product-desktop.png
- C:/Users/ADMINI~1/AppData/Local/Temp/xunlu-ui-refresh-qa/sample-desktop.png
- C:/Users/ADMINI~1/AppData/Local/Temp/xunlu-ui-refresh-qa/pricing-desktop.png
- C:/Users/ADMINI~1/AppData/Local/Temp/xunlu-ui-refresh-qa/home-mobile.png

viewport:
- Desktop: 1280 x 720
- Mobile: 390 x 844

state:
- Public static site, hash routes: home, product, checkup, sample, pricing.

full-view comparison evidence:
- The rendered pages now use the source visual system: fixed dark navy header, white content canvas, bordered white cards, teal primary buttons, teal active nav underline, report-style tables, dark navy footer, and QR/contact blocks.

focused region comparison evidence:
- Header and hero: desktop and mobile checked against the home reference.
- Product and sample pages: checked against the product/report references for large card layout and table treatment.
- Pricing page: checked against the service-plan reference while preserving existing production prices.

findings:
- No P0/P1/P2 issues remain.
- Intentional deviation: pricing values remain the existing live values (`0`, `29.9`, `99`, `199/季起`) instead of the mockup values, per user instruction.
- Intentional deviation: contact phone remains `18233662815`, matching the current production requirement.

patches made since previous QA pass:
- Added UI refresh cache version.
- Added homepage trust/kicker pill.
- Added online-evaluation three-step indicator.
- Added full-site CSS refresh for header, hero, cards, forms, tables, pricing, footer, and responsive breakpoints.

final result: passed
