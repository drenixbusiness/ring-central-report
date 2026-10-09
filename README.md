# rc-hr-daily-report

RingCentral’dan HR xodimlarining kunlik qo‘ng‘iroq va SMS statistikasini olib, Google Sheets’dagi **“RING CENTRAL”** tabiga avtomatik yozadigan servis. Kompaniya serverida PM2 orqali doimiy ishlaydi. Telegram bot yoki veb-interfeys yo‘q. Bot loglari va CLI chiqishlari ingliz tilida.

---

## 1. Qisqa arxitektura

```
            node-cron (America/Chicago)
   00:00 daily | 00:15 late-recheck | har soat :30 retry | startup catch-up
                         │
                         ▼
   Scheduler ──► planner (qaysi sana × HR)  ◄── SQLite state (hr_day, runs)
                         │
           SQLite process lock (scheduler va CLI uchun umumiy)
                         │
                         ▼
   ReportRunner ──► RcDataSource ──► RcClient (@ringcentral/sdk, JWT)
        │              call-log, message-store       rate-limit, retry, pagination
        │
        ├─► metrics/calls.js  (session bo‘yicha dedup, missed mapping)
        ├─► metrics/sms.js    (Sent/Delivered, unique message ID)
        │
        ▼
   SheetWriter ──► Google Sheets API (service account)
        qator kaliti = developerMetadata "YYYY-MM-DD|extensionId"
```

| Fayl | Vazifasi |
|---|---|
| `src/index.js` | PM2 kirish nuqtasi (`npm start`), scheduler, graceful shutdown |
| `src/scheduler.js` | node-cron jadvallari, `timezone: America/Chicago` |
| `src/report/planner.js` | Qaysi (sana, HR) juftliklari ishlanishini aniqlaydi: reconcile, catch-up, retry/backoff |
| `src/report/reportRunner.js` | Ma’lumot olish → hisoblash → Sheets’ga upsert → state |
| `src/ringcentral/rcClient.js` | SDK wrapper: JWT login, 429/5xx/401 bilan ishlash, pagination |
| `src/ringcentral/rcDataSource.js` | Ishlatiladigan RingCentral endpoint’lari (faqat o‘qish) |
| `src/metrics/callResults.js` | RingCentral `result` qiymatlarining aniq mapping’i |
| `src/metrics/calls.js`, `src/metrics/sms.js` | Hisoblash qoidalari |
| `src/sheets/sheetWriter.js` | Tab/header tekshiruvi, metadata orqali upsert, timeout’dan keyin tekshirib qayta urinish |
| `src/state/stateStore.js`, `src/state/processLock.js` | SQLite holat va jarayonlararo lock |
| `src/time.js` | Central Time kun chegaralari (DST bilan) |
| `src/cli/*.js` | `check`, `list-extensions`, `report`, `status` buyruqlari |
| `test/*.test.js` | Avtomatik testlar (`node:test`) |

---

## 2. Hisoblash qoidalari

Bu ko‘rsatkichlar **bizning ta’rifimiz** bo‘yicha hisoblanadi va RingCentral Analytics hisobotlari bilan avtomatik bir xil chiqishi kafolatlanmaydi.

### Kun
* Hisobot kuni = `REPORT_TIMEZONE` (America/Chicago) bo‘yicha `[00:00, keyingi kun 00:00)`: boshi kiradi, oxiri kirmaydi. Chegaralar UTC’ga o‘giriladi.
* Server vaqt zonasi va doimiy offset (UTC-6) ishlatilmaydi. DST kunlari 23 yoki 25 soat bo‘ladi (2026-03-08 = 23 soat, 2026-11-01 = 25 soat).
* 2026-10-10 00:00 CT dagi ish 2026-10-09 kun uchun hisobot tuzadi.

### Qo‘ng‘iroqlar (`call-log`, `type=Voice`, `view=Simple`)
* **Bitta qo‘ng‘iroq**: bitta HR extension’i ichida bir xil `sessionId` *yoki* `telephonySessionId` ga ega yozuvlar bitta qo‘ng‘iroq hisoblanadi (zanjir bo‘lib bog‘langanlari ham). `id` faqat bitta call log yozuvining identifikatori, u faqat session ID bo‘lmaganda ishlatiladi. Deduplikatsiya **har bir extension uchun alohida** qilinadi, shu sabab ikki HR qatnashgan qo‘ng‘iroq ikkalasiga ham hisoblanadi.
* **Kun**: qo‘ng‘iroq yozuvlaridagi eng erta `startTime` bo‘yicha. Yarim tundan o‘tadigan leg’larni ko‘rish uchun API’dan kun atrofida ±`CALL_LOG_BUFFER_MINUTES` (120 daqiqa) qo‘shimcha olinadi.
* **Total inbound calls**: guruhda `direction=Inbound` yozuv bo‘lsa, javob berilgan-berilmaganidan qat’i nazar. `Blocked` (bloklangan raqam) hisobga kirmaydi.
* **Total outbounds calls**: guruhda inbound yozuv yo‘q va HR boshlagan `Outbound` yozuv bor bo‘lsa. Javob berilgan, `No Answer`, `Busy`, `Call Failed`, `Wrong Number` va hokazo urinishlarning hammasi kiradi. Texnik leg’lar (`FindMe`, `FollowMe`, `Sip Forwarding`, `Hunting`, `Transfer`, `Move`, `RingMe`, `Accept Call`, `Pickup`, `Call Park`) outbound hisoblanmaydi.
* **Total missed calls**: inbound guruhda birorta leg ham javob berilmagan (`Accepted`/`Call connected` yo‘q) va natijalar quyidagi “missed” toifasida bo‘lsa: `Missed`, `No Answer`, `Answered Not Accepted`, `Voicemail`, `Sent to Voicemail`, `Rejected`, `Declined`, `Reply`, `Busy`, `Hang Up`, `Abandoned`, `Stopped`, xatolik natijalari. Missed inbound’ning ichki qismi.
* **Total calls** = inbound + outbound. Missed qayta qo‘shilmaydi.
* Fax (`type=Fax`) va suhbat bo‘lmagan action’lar (`Monitoring`, `Barge In Call`, `Paging`, `Phone Login`, `E911 Update`, `Park Location`) chiqarib tashlanadi. HR log’ida qayd etilgan ichki (extension→extension) qo‘ng‘iroqlar hisoblanadi.
* RingCentral API’da **`Transferred` degan result qiymati yo‘q** (rasmiy OpenAPI `CallResultEnum` tekshirildi). Transfer `action: Transfer`, `reason` va `transferTarget` orqali ko‘rinadi. HR javob berib keyin transfer qilgan qo‘ng‘iroq `Accepted` bo‘lib keladi, ya’ni “answered”.
* `In Progress` (davom etayotgan qo‘ng‘iroq): missed hisoblanmaydi, qator yoziladi, lekin holati `provisional` bo‘lib qoladi va keyingi retry/reconcile ishida qayta tekshiriladi.
* **Noma’lum result**: inbound qo‘ng‘iroqda mapping’da yo‘q qiymat chiqsa, u **hech qachon missed deb olinmaydi**. Standart siyosat (`UNKNOWN_CALL_RESULT_POLICY=fail`) bo‘yicha o‘sha HR/kun yozilmaydi, logda `UNKNOWN_CALL_RESULT` va qiymatlar ro‘yxati chiqadi. Mapping’ni `src/metrics/callResults.js` da to‘ldirish kerak. `count-not-missed` siyosatida inbound sifatida hisoblanadi, missed sifatida emas, va ogohlantirish chiqadi.
* O‘chirilgan call log yozuvlari (`showDeleted=true`) ham hisoblanadi, chunki ular haqiqiy qo‘ng‘iroq bo‘lgan (`RC_INCLUDE_DELETED_CALLS`).

### SMS (`message-store`)
* Faqat `type=SMS`, `direction=Outbound`, `messageStatus` = `Sent` yoki `Delivered`.
  * `Sent`: RingCentral xabarni operatorga muvaffaqiyatli uzatgan.
  * `Delivered`: operator telefonga yetkazilganini tasdiqlagan.
  * Bu ikki xil kafolat. Ikkalasi ham “muvaffaqiyatli yuborilgan” deb sanaladi, lekin `Sent` yetkazilganini bildirmaydi.
* Hisoblanmaydi: `Queued`, `SendingFailed`, `DeliveryFailed`, `Received`, noma’lum statuslar (logda ko‘rsatiladi), inbound SMS, Fax, VoiceMail, Pager (ichki xabar).
* Bitta unique message `id` = 1. Billing segmentlari ko‘paytirilmaydi. Bir xil matn yangi `id` bilan yuborilsa, alohida hisoblanadi.
* Kun `creationTime` bo‘yicha. Status keyin o‘zgarsa (masalan `Queued` → `Delivered` yoki `Sent` → `DeliveryFailed`), reconcile o‘sha **dastlabki sana** qatorini yangilaydi.
* **Bir nechta recipient’li yozuv**: xabar bitta `id` bo‘lgani uchun ko‘pi bilan **1** marta sanaladi (recipient soniga ko‘paytirilmaydi). Yozuvning umumiy statusi `Sent`/`Delivered` bo‘lishi shart. Agar `to[]` ichida recipient statuslari bo‘lsa, kamida bittasi `Sent`/`Delivered` bo‘lishi kerak. Hammasi muvaffaqiyatsiz bo‘lsa, xabar sanalmaydi. Muvaffaqiyatsiz recipient hech qachon muvaffaqiyatli SMS deb sanalmaydi.
* HR ilovada o‘chirgan SMSlar ham hisoblanadi (`availability=Alive,Deleted,Purged`), chunki ular yuborilgan. RingCentral xabarni butunlay o‘chirib yuborsa (purge), keyingi reconcile’da u sanalmay qolishi mumkin.

---

## 3. RingCentral sozlamalari

1. **Developer Console** → app (yoki yangi “REST API App”, server-only/no UI):
   * Auth: **JWT auth flow** yoqilgan.
   * App scopes: **ReadAccounts**, **ReadCallLog**, **ReadMessages**.
   * Production’ga chiqarilgan (graduated) bo‘lishi kerak. Production URL: `https://platform.ringcentral.com`.
2. **JWT credential**: admin foydalanuvchi uchun yarating (Developer Console → Credentials → JWT). U `.env` dagi `RC_JWT` ga yoziladi.
3. **Muhim:** app scope bo‘lishi bilan foydalanuvchining boshqa mailbox’larni o‘qiy olishi bir narsa emas.
   * Boshqa xodimlarning call log’i uchun JWT egasining roli (masalan Super Admin yoki kompaniya call log’iga kirishi bor custom role) kerak.
   * `message-store` foydalanuvchi mailbox’i resursi. Ba’zi akkauntlarda admin JWT boshqa foydalanuvchining SMSlarini o‘qiy olmaydi (`403`, masalan `CMN-408`). Unda rasmiy yo‘llar: (a) o‘sha mailbox’ga kirish huquqi bor foydalanuvchi uchun berilgan JWT; (b) RingCentral’ning akkaunt darajasidagi **Message Store Report (export)** API’si (`/restapi/v1.0/account/~/message-store-report`, `ReadMessages` scope + admin “Users” permission). Hozirgi kod (b) variantni amalga oshirmaydi. Ruxsatni chetlab o‘tadigan yechim ishlatilmaydi.
   * `npm run check` har bir HR uchun call log va message store’ga kirishni alohida tekshiradi.
4. **Extension ID ≠ extension number.** `hr.config.json` ga uzun ichki **extensionId** yoziladi (`npm run list-extensions` dagi birinchi ustun), qisqa “Ext #” emas.

API bo‘yicha tekshirilgan ma’lumotlar (RingCentral OpenAPI `rc-platform.yml`, API 1.0.58):

| Endpoint | Throttling | Scope | Parametrlar |
|---|---|---|---|
| `GET /restapi/v1.0/account/~/extension` | Medium | ReadAccounts | `type`, `status`, `page`, `perPage` |
| `GET /restapi/v1.0/account/~/phone-number` | Heavy | ReadAccounts | `page`, `perPage` |
| `GET .../extension/{extensionId}/call-log` | Heavy | ReadCallLog | `dateFrom`, `dateTo`, `type`, `view` (Simple: perPage ≤ 1000), `showDeleted`, `page` |
| `GET .../extension/{extensionId}/message-store` | Light | ReadMessages | `dateFrom`, `dateTo`, `messageType`, `direction`, `availability` (ko‘p qiymatli), `page`, `perPage` |

Pagination: `navigation.nextPage` va `paging.totalPages` bo‘yicha barcha sahifalar yuklanadi. Agar navigation bo‘lmasa-yu sahifa to‘la kelsa, keyingi sahifa ham tekshiriladi.

Rate limit: concurrency `RC_MAX_CONCURRENCY` (2). `X-Rate-Limit-Remaining=0` bo‘lsa, guruh `X-Rate-Limit-Window` davomida kutadi. `429` bo‘lsa, `Retry-After` kutiladi. Network/5xx xatolarda cheklangan exponential backoff (`RC_MAX_RETRIES`). `401` bo‘lsa, faqat bir marta JWT bilan qayta login qilinadi. `403/400/404` qayta urinilmaydi. Bir necha kunlik oraliq har bir HR uchun bitta paginated so‘rov bilan olinadi.

---

## 4. Google Sheets sozlamalari

1. Google Cloud Console → loyiha → **Google Sheets API** ni yoqing.
2. **IAM & Admin → Service Accounts** → service account yarating → **Keys → Add key → JSON**. Faylni serverga, masalan `/opt/rc-hr-daily-report/secrets/google-service-account.json` ga joylang:
   ```bash
   chmod 600 /opt/rc-hr-daily-report/secrets/google-service-account.json
   ```
3. JSON ichidagi `client_email` (masalan `rc-report@project.iam.gserviceaccount.com`) manzilini nusxalang. `npm run check` ham uni chiqaradi.
4. Spreadsheet’ni oching → **Share** → shu email → **Editor** → Send (notify belgisini olib tashlash mumkin).
5. `.env`: `GOOGLE_SPREADSHEET_ID` = URL’dagi `/d/<ID>/edit` qismi, `GOOGLE_SHEET_NAME=RING CENTRAL`.

Tab ishlashi:
* Tab bo‘lmasa yaratiladi va A1:H1 ga sarlavhalar yoziladi: `Date | HR name | HR's phone number | Total inbound calls | Total outbounds calls | Total missed calls | Total calls | Total SMS send`.
* Sarlavhalar boshqacha bo‘lsa, **hech narsa yozilmaydi**. Har bir ustun bo‘yicha “expected/found” diagnostikasi chiqadi (`SHEETS_HEADER_MISMATCH`).
* Har bir qatorga ko‘rinmas **developer metadata** biriktiriladi: `rc-hr-daily-report:row-key = YYYY-MM-DD|extensionId`. Qatorlarni saralash yoki HR ismi/raqamini o‘zgartirish dublikat yaratmaydi. **Bot yaratgan qatorlarni qo‘lda nusxalamang**: metadata nusxalanmaydi. Qatorni o‘chirsangiz, keyingi qayta ishlashda u qaytadan qo‘shiladi.
* Qiymatlar `RAW` / typed cell sifatida yoziladi: `+1312...` matn bo‘lib qoladi, `=...` formula bo‘lmaydi, statistikalar son bo‘ladi, sana `YYYY-MM-DD` matni.
* Faqat bot qatorlarining A:H ustunlari yoziladi. Boshqa tablar, formatlar va I+ ustunlar o‘zgarmaydi.
* Yangi qatorlar bitta atomik `batchUpdate` (qiymat + metadata) bilan qo‘shiladi. Javob timeout bo‘lsa, avval metadata qayta o‘qiladi va faqat haqiqatan yozilmagan qatorlar qayta yuboriladi.

---

## 5. Serverga o‘rnatish

Talablar: Linux server, **Node.js 22 yoki 24 LTS** (`node -v`), npm, PM2. `better-sqlite3` Linux x64/arm64 uchun tayyor binary bilan keladi. Bo‘lmasa `build-essential` va `python3` kerak bo‘ladi.

```bash
sudo mkdir -p /opt/rc-hr-daily-report && sudo chown "$USER" /opt/rc-hr-daily-report
```
Loyiha fayllarini shu papkaga ko‘chiring (git yoki scp), keyin:
```bash
cd /opt/rc-hr-daily-report
```
```bash
npm ci --omit=dev
```
```bash
cp .env.example .env && chmod 600 .env
```
```bash
cp hr.config.example.json hr.config.json
```
```bash
mkdir -p secrets data logs
```
`.env` ni tahrirlang: `RC_CLIENT_ID`, `RC_CLIENT_SECRET`, `RC_JWT`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_SPREADSHEET_ID`, `REPORT_START_DATE`. Barcha o‘zgaruvchilar `.env.example` da izohlangan. `.env`, `hr.config.json`, `secrets/`, `data/`, `logs/` papkalari `.gitignore` da.

### hr.config.json
```json
{
  "hrs": [
    {
      "extensionId": "<npm run list-extensions dagi ExtensionId>",
      "name": "<hisobotdagi ism>",
      "phoneNumber": "+1XXXXXXXXXX",
      "reportStartDate": "2026-10-01",
      "reportEndDate": null
    }
  ]
}
```
* `reportEndDate`: ixtiyoriy (HR ishdan ketganda). `"enabled": false` bilan yozuvni vaqtincha o‘chirish mumkin.
* Hisobot `max(REPORT_START_DATE, reportStartDate)` dan boshlanadi.
* Faqat ro‘yxatdagi HRlar uchun hisobot tuziladi. RingCentral’dagi boshqa xodimlar hisobga olinmaydi.
* Faylni o‘zgartirgandan keyin: `pm2 restart rc-hr-daily-report`.

---

## 6. Birinchi tekshiruv tartibi (bitta HR, bitta kun)

1. Konfiguratsiya va kirishlarni tekshirish (faqat o‘qiydi):
   ```bash
   npm run check
   ```
   Hammasi `[OK]` bo‘lishi kerak. `[FAIL]` qatori nima yetishmayotganini aytadi (scope, rol, Sheets share).
2. Extension’larni ko‘rish va `hr.config.json` ni to‘ldirish:
   ```bash
   npm run list-extensions
   ```
   Barcha turlarni yoki JSON skeletini ko‘rish uchun: `npm run list-extensions -- --all` yoki `-- --json`.
3. Avval `hr.config.json` ga **bitta HR** yozing. So‘ng Central Time bo‘yicha **yakunlangan** kun bilan dry-run qiling (Sheets va state o‘zgarmaydi):
   ```bash
   npm run report -- --date 2026-10-09 --dry-run --verbose
   ```
   Natijani RingCentral Admin Portal / app’dagi call log va SMS bilan qo‘lda solishtiring. `--verbose` diagnostikani ham chiqaradi: chiqarib tashlangan yozuvlar, texnik leg’lar, status bo‘yicha taqsimot.
4. Birinchi haqiqiy yozuv:
   ```bash
   npm run report -- --date 2026-10-09
   ```
   Sheets’da bitta qator paydo bo‘lishini tekshiring.
5. Shu buyruqni **yana** ishga tushiring. Qator yangilanishi, yangi qator qo‘shilmasligi kerak (`Inserted rows: 0, updated rows: 1`).
6. Qolgan HRlarni qo‘shing, `npm run check` ni qayta ishga tushiring, kerak bo‘lsa tarixni to‘ldiring:
   ```bash
   npm run report -- --from 2026-10-01 --to 2026-10-09
   ```
7. PM2 ni ishga tushiring (keyingi bo‘lim).

`--hr <extensionId>` faqat tanlangan HR(lar)ni ishlaydi. Tugallanmagan kun (bugun) rad etiladi.

---

## 7. PM2

```bash
npm install -g pm2
```
Ishga tushirish (`instances: 1`, `exec_mode: fork`, `autorestart`, aniq `cwd`, `logs/out.log` va `logs/error.log`):
```bash
pm2 start ecosystem.config.cjs --env production
```
Holat va loglar:
```bash
pm2 status
```
```bash
pm2 logs rc-hr-daily-report --lines 200
```
Qayta ishga tushirish (`.env` yoki `hr.config.json` o‘zgarganda):
```bash
pm2 restart rc-hr-daily-report --update-env
```
To‘xtatish va qayta boshlash:
```bash
pm2 stop rc-hr-daily-report
```
```bash
pm2 start rc-hr-daily-report
```
**Server reboot’dan keyin avtomatik ishga tushish:**
```bash
pm2 startup
```
Bu buyruq `sudo env PATH=... pm2 startup systemd -u <user> --hp <home>` ko‘rinishidagi buyruqni chiqaradi. Uni aynan nusxalab ishga tushiring. So‘ng joriy jarayonlar ro‘yxatini saqlang:
```bash
pm2 save
```
Reboot’dan keyin PM2 saqlangan ro‘yxatni tiklaydi. Bot ishga tushganda (`CATCH_UP_ON_START=true`) o‘tkazib yuborilgan kunlarni o‘zi to‘ldiradi. Qo‘lda tiklash: `pm2 resurrect`.

**Log rotation** (pm2-logrotate moduli):
```bash
pm2 install pm2-logrotate
```
```bash
pm2 set pm2-logrotate:max_size 10M
```
```bash
pm2 set pm2-logrotate:retain 30
```
```bash
pm2 set pm2-logrotate:compress true
```
```bash
pm2 set pm2-logrotate:rotateInterval "0 0 * * *"
```

Log namunasi:
```
2026-10-10T05:00:12.345Z INFO  [report] HR day written date=2026-10-09 extensionId=62000000001 inbound=12 outbound=30 missed=3 total=42 sms=17
2026-10-10T05:00:13.001Z ERROR [report] Data fetch failed; nothing will be written for these days extensionId=62000000002 dates=2026-10-06..2026-10-09 errorCode=RC_403 rcErrorCode=CMN-408 ...
```
Loglarga JWT, token, secret, SMS matni va to‘liq API payload yozilmaydi. Logger sezgir nomli maydonlarni qo‘shimcha ravishda `[REDACTED]` qiladi.

---

## 8. Jadval va qayta tekshirish

| Ish | Cron (`America/Chicago`) | Nima qiladi |
|---|---|---|
| daily | `0 0 * * *` | Kechagi kun + undan oldingi `RECONCILE_DAYS` (3) kun + boshlanish sanasidan beri yetishmayotgan/failed kunlar |
| late-recheck | `15 0 * * *` | Kechagi kunni qayta oladi (kech tushgan call log, SMS statuslari) |
| retry | `30 * * * *` | Failed/yetishmayotgan juftliklar, backoff bilan (5 daqiqa × 2ⁿ, maksimum 6 soat) |
| startup | ishga tushganda | Restart/reboot paytida o‘tkazib yuborilgan kunlar |

* 00:00 — ishning **boshlanish** vaqti. API va Sheets yozuvlari shu soniyada tugashi va’da qilinmaydi (rate limit sabab bir necha daqiqa olishi mumkin).
* Qayta ishlash dublikat yaratmaydi: kalit `reportDate + extensionId`.
* Bir HR uchun 401/403 xato 3 marta takrorlansa, avtomatik retry to‘xtaydi (har kuni daily ishda bir marta qayta urinadi). Ruxsatni tuzatgandan keyin `npm run report -- --from ... --to ...` ni ishga tushiring.
* Scheduler va qo‘lda CLI bir vaqtda yozmasligi uchun SQLite’da umumiy lock bor. CLI band lockni kutmaydi va xabar beradi. Scheduler 30 daqiqagacha kutadi (`LOCK_WAIT_MS`).

### Holat bazasi
`STATE_DB_PATH` (standart `data/state.sqlite`): `hr_day` jadvali (`pending | ok | provisional | failed`, oxirgi yozilgan qiymatlar, xato kodi, urinishlar soni), `runs` jadvali va `process_lock`. Ko‘rish:
```bash
npm run status
```
Bir HR ma’lumoti to‘liq olinmasa (istalgan sahifa xatosi), u HR/kun **yozilmaydi**. Sheets’dagi mavjud to‘g‘ri qator o‘zgarmaydi, juftlik `failed` bo‘lib qayta ishlash uchun saqlanadi, qolgan HRlar davom etadi.

---

## 9. Xato kodlari

| Kod | Ma’nosi |
|---|---|
| `RC_401` | Credential noto‘g‘ri yoki JWT bekor qilingan |
| `RC_403` | Scope yoki rol yetarli emas. Logda qaysi ruxsat kerakligi yoziladi |
| `RC_404` | extensionId topilmadi (ehtimol extension number yozilgan) |
| `RC_429` / `RC_5xx` / `RC_NETWORK` | Retry’lardan keyin ham muvaffaqiyatsiz; keyingi retry ishida qayta uriniladi |
| `UNKNOWN_CALL_RESULT` | Mapping’da yo‘q result qiymati; `callResults.js` ni yangilang |
| `SHEETS_HEADER_MISMATCH` | A1:H1 sarlavhalari mos emas |
| `SHEETS_INSERT_FAILED` / `SHEETS_ERROR` | Google Sheets yozuvi muvaffaqiyatsiz |
| `LOCK_BUSY` | Boshqa jarayon yozmoqda |

---

## 10. Testlar

```bash
npm test
```
Testlar `node:test` bilan yozilgan, tarmoqqa ulanmaydi (RingCentral va Sheets uchun in-memory fake’lar). Qamrab olingan holatlar:

* Central Time chegaralari, DST 23/25 soatlik kunlar, 00:00 da ishlash → oldingi sana, server TZ’ga bog‘liq emaslik.
* Missed Total calls’da ikki marta sanalmasligi; voicemail/rejected/busy → missed; outbound urinishlar.
* Call leg, transfer, RingOut, FindMe/FollowMe forwarding’da ortiqcha hisoblash yo‘qligi; extension bo‘yicha dedup.
* Rasmiy `CallResultEnum` ning barcha qiymatlari mapping’da borligi; noma’lum result missed bo‘lmasligi.
* SMS: Sent/Delivered hisoblanadi; Queued/failed/inbound/pager hisoblanmaydi; multi-recipient qoidasi; keyin failed bo‘lgan SMS chiqib ketishi.
* Pagination (nextPage, totalPages, navigation’siz to‘la sahifa), 429 Retry-After, rate-limit oynasi, 5xx backoff, 403 retry qilinmasligi, 401 → bitta re-login.
* Sheets: tab/header yaratish, header mismatch diagnostikasi, qayta ishlashda dublikat yo‘qligi (ism o‘zgarishi va saralashdan keyin ham), RAW matn/raqam, timeout’dan keyin tekshirib yozish (server qo‘llagan va qo‘llamagan holatlar), boshqa tab/kataklar saqlanishi.
* API xatosi nol sifatida yozilmasligi, boshqa HRlar davom etishi, mavjud qator saqlanishi; dry-run hech narsa yozmasligi.
* Kech kelgan yozuv/SMS status reconcile’da o‘sha qatorni yangilashi; crash/restart’dan keyin pending va yetishmayotgan kunlar tiklanishi; process lock (band/stale).

---

## 11. Nima tekshirildi va nima tekshirilmadi

**Ishlab chiqish muhitida amalda bajarildi (Windows, Node v24.16.0):**
* `npm test`: 73 ta test, hammasi o‘tdi.
* `npm run check` va `npm run report` credential’siz ishga tushirildi: tushunarli konfiguratsiya xatolari bilan to‘xtaydi.
* `node-cron` `0 0 * * *` + `America/Chicago` uchun keyingi ishga tushish vaqtini to‘g‘ri hisobladi (05:00Z, CDT), mashina vaqt zonasi boshqa bo‘lsa ham.
* Endpoint’lar, parametrlar, pagination modeli, `CallResultEnum`/`CallActionEnum`/`MessageStatusEnum`, throttling guruhlari va permission’lar rasmiy RingCentral OpenAPI spetsifikatsiyasidan (`rc-platform.yml`, 1.0.58) tekshirildi.

**Credential bo‘lmagani uchun tekshirilmadi (birinchi ishga tushirishda 6-bo‘limdagi tartib bilan tekshiring):**
* Haqiqiy RingCentral JWT login, token scope’lari, haqiqiy javob tuzilmasi va rate-limit header’lari.
* Admin JWT sizning akkauntingizda boshqa HRlarning **message-store**’ini o‘qiy oladimi yoki yo‘qmi. Bu akkaunt va rol sozlamalariga bog‘liq. `npm run check` buni ko‘rsatadi.
* Haqiqiy call log’da transfer/queue/RingOut yozuvlari aynan qanday ko‘rinishi. Mantiq rasmiy maydon ta’riflariga asoslangan, lekin real ma’lumot bilan dry-run orqali solishtirish shart.
* Haqiqiy Google Sheets API: developer metadata qidiruvi va `batchUpdateByDataFilter` real spreadsheet’da (fake bilan test qilingan), service account ulanishi.
* Linux serverda PM2, `pm2 startup` va `pm2-logrotate`.
* Haqiqiy DST o‘tish kunida cron ishlashi (faqat unit test darajasida).

---

## 12. Foydali buyruqlar

| Buyruq | Vazifasi |
|---|---|
| `npm start` | Scheduler (PM2 orqali ishlatiladi) |
| `npm run check` | Konfiguratsiya va API kirishlarini tekshirish (read-only) |
| `npm run list-extensions` | Extension’lar ro‘yxati (read-only) |
| `npm run report -- --date 2026-10-09` | Bitta kunni yozish/yangilash |
| `npm run report -- --from 2026-10-01 --to 2026-10-09` | Tarixiy davr |
| `npm run report -- --date 2026-10-09 --dry-run` | Sheets’ga yozmasdan ko‘rish |
| `npm run status` | Oxirgi ishlar va tugallanmagan HR/kunlar |
| `npm test` | Avtomatik testlar |
