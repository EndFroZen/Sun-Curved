# คู่มือเขียน Deploy YAML ของ Sun Curved

## 1. ภาพรวม: YAML ไปเป็น sh แล้วรันอย่างไร

คุณเขียนแค่ YAML ไฟล์เดียวบอกว่า "อยากให้ deploy แบบไหน" ส่วน Sun Curved แปลง YAML นั้นเป็นสคริปต์ bash ทั้งไฟล์ แล้วส่งไปรันบนเครื่องปลายทางผ่าน SSH ที่ล็อกอินไว้แล้ว แนวคิดเดียวกับ Kubernetes คือ YAML เป็นคำประกาศ ส่วนขั้นตอนจริงเป็นงานของโปรแกรม

เมื่อกด **Apply** ในหน้า Deploy จะเกิดขึ้นตามลำดับนี้:

1. **ตรวจ YAML ในแอป** ถ้าผิดจะขึ้นข้อความสีแดงเหนือตัวแก้ และไม่มีอะไรถูกส่งไปที่เครื่อง
2. **บันทึก YAML** ลงเครื่องที่ `~/EndFroZen/SunCurved/deployments/<name>.yaml`
3. **ตรวจก่อนรัน:** ดึงรายการ tag จาก git และดูว่า target ไหนมีไฟล์แก้ค้าง
4. **Popup ยืนยัน:** เลือก tag และติ๊กยืนยันทิ้งไฟล์ที่แก้ค้าง (ถ้ามี)
5. **แปลงเป็น bash:** ใส่ tag ที่เลือก คำตอบเรื่องไฟล์แก้ค้าง และรหัส sudo ลงในสคริปต์
6. **รัน:** ส่งสคริปต์ทั้งก้อนเข้า `bash -l -s` บนเครื่อง output ขึ้นใน Deploy log ทีละบรรทัดระหว่างรัน (มุมขวาของ Deploy log: **Clear** ล้าง log, **Full** ขยายเต็มจอ กด **ย่อ** หรือ Esc เพื่อกลับ)
7. **บันทึกผล:** เขียน tag, ok หรือ failed และเวลา ลง `~/EndFroZen/SunCurved/state/<name>`

**ไฟล์ที่เกิดบนเครื่องปลายทางมีแค่ 2 ไฟล์ต่อ deployment:**

| ไฟล์ | เก็บอะไร | ใครเขียน |
| --- | --- | --- |
| `~/EndFroZen/SunCurved/deployments/<name>.yaml` | YAML ที่คุณเขียน | แอป ตอนกด Apply |
| `~/EndFroZen/SunCurved/state/<name>` | `<tag> ok\|failed <วันที่ เวลา>` | สคริปต์ ตอนรันจบ |

ตอน Apply ไม่มีไฟล์ `.sh` ถูกเขียนลงดิสก์ สคริปต์อยู่ในหน่วยความจำของ bash ขณะรันเท่านั้น (ถ้าอยากได้ไฟล์ไว้รันเอง ใช้ **⋯ → Save sh ลงเครื่อง** ดูหัวข้อ 9) รหัส sudo จึงไม่ค้างอยู่ในไฟล์ใด และไม่โผล่ใน `ps` ถ้าอยากเห็นสคริปต์ที่จะรันจริง กดแท็บ **sh** ในแถบมุมมอง

## 2. พื้นฐาน YAML ที่ต้องรู้

YAML ใช้การย่อหน้าบอกว่าอะไรอยู่ใต้อะไร กฎที่สำคัญที่สุดคือ**ย่อหน้าด้วยช่องว่าง 2 ช่อง ห้ามใช้ Tab** ในตัวแก้ของแอป กด Tab แล้วได้ช่องว่าง 2 ช่องให้อยู่แล้ว

### Map (key: value)

```yaml
metadata:          # key ที่มีของอยู่ข้างใน ลงท้ายด้วย : แล้วขึ้นบรรทัดใหม่
  name: my-app     # ย่อเข้า 2 ช่อง = อยู่ใต้ metadata
```

- หลัง `:` ต้องมีช่องว่าง 1 ช่องเสมอ เช่น `name: my-app` ไม่ใช่ `name:my-app`
- key ที่อยู่ระดับเดียวกันต้องย่อหน้าเท่ากันทุกช่อง
- ชื่อ key ตัวพิมพ์เล็ก-ใหญ่ต่างกัน: `envFrom` ไม่เท่ากับ `envfrom`

### List (รายการ)

แต่ละรายการขึ้นต้นด้วย ` -  ` ถ้ารายการมีหลาย key ให้ key ถัดไปตรงแนวกับ key แรกหลัง ` -  `

```yaml
targets:
  - name: main            # รายการที่ 1
    path: ~/app-main      # ตรงแนวกับ name (ไม่ใช่ตรงกับ -)
  - name: sub             # รายการที่ 2
    path: ~/app-sub
```

### เขียนแบบบรรทัดเดียว (flow style)

สองแบบนี้ความหมายเหมือนกัน ใช้แบบไหนก็ได้:

```yaml
auth: { user: GITHUB_USERNAME, token: GITHUB_TOKEN }

auth:
  user: GITHUB_USERNAME
  token: GITHUB_TOKEN
```

### Comment

ทุกอย่างหลัง `#` คือ comment ถูกข้ามตอนอ่าน ในกรณีเป็นค่า ต้องมีช่องว่างก่อน `#` เช่น `dirty: ask   # ถามก่อน`

### เมื่อไหร่ต้องใส่เครื่องหมายคำพูด

ค่าส่วนใหญ่ไม่ต้องใส่ แต่ใส่ `"..."` เมื่อ:

- ค่าขึ้นต้นด้วย `{` `[` `*` `&` `!` `%` `@` หรือ `` ` ``
- ค่ามี ` :  ` (โคลอนตามด้วยช่องว่าง) หรือ `  # ` อยู่ข้างใน
- อยากให้เป็นข้อความแทนตัวเลขหรือ true/false เช่น `version: "1.10"` (ไม่ใส่ จะได้ 1.1)

### คำสั่งหลายบรรทัด (`|`)

ใช้ `|` แล้วเขียนคำสั่งในบรรทัดถัดไป ย่อหน้าเข้าไปอีก 2 ช่อง ทุกบรรทัดถูกรันตามลำดับ บรรทัดไหนพัง deploy หยุดทันที:

```yaml
    build: |
      npm ci
      npm run build
      pm2 reload ecosystem.config.js
```

### ข้อผิดพลาดยอดฮิต

| เขียนผิด | ที่ถูก | ทำไม |
| --- | --- | --- |
| ใช้ Tab ย่อหน้า | ช่องว่าง 2 ช่อง | YAML ห้าม Tab |
| `name:main` | `name: main` | ต้องมีช่องว่างหลัง `:` |
| key ใน list ตรงกับ `-` | ตรงกับ key แรกหลัง ` -  ` | ไม่งั้นกลายเป็น key ของระดับบน |
| `version: 1.10` | `version: "1.10"` | ไม่ใส่เครื่องหมายคำพูด จะกลายเป็นตัวเลข 1.1 |
| key ซ้ำในระดับเดียวกัน | เหลือตัวเดียว | YAML แจ้ง error "Map keys must be unique" |

## 3. โครงสร้างทั้งไฟล์ + apiVersion / kind / metadata

ทุกไฟล์มีหน้าตาแบบนี้ (ช่องที่มี `?` ไม่บังคับ):

```yaml
apiVersion: suncurved/v1        # บังคับ ค่าตายตัว
kind: Deployment                # บังคับ ค่าตายตัว
metadata:
  name: <ชื่อ>                  # บังคับ
spec:
  envFrom: <ไฟล์ env>           # ?
  sudo: login-password | none   # ? (ค่าเริ่มต้น none)
  source:
    repo: <git repo>            # บังคับ
    auth: { user: VAR, token: VAR }   # ?
    version: tag | <ชื่อ tag>   # ? (ค่าเริ่มต้น tag)
    branch: <ชื่อ branch>       # ? ใช้แทน version ถ้าไม่มี tag
  targets:                      # บังคับ อย่างน้อย 1
    - name: <ชื่อ>
      path: <โฟลเดอร์ git>
      dirty: ask | discard | fail   # ? (ค่าเริ่มต้น ask)
      build: <คำสั่ง>           # ?
      pm2: <ชื่อ process>       # ?
      mounts:                   # ?
        - from: <ต้นทาง>
          to: <ปลายทาง>
```

key ที่ไม่รู้จัก (เช่นพิมพ์ผิดเป็น `biuld`) **จะถูกเงียบข้ามไป ไม่ error** ถ้าทำงานไม่ตรงใจ ให้กดแท็บ **sh** ดูว่าขั้นตอนนั้นอยู่ในสคริปต์จริงหรือไม่

### apiVersion และ kind

ต้องเป็น `suncurved/v1` และ `Deployment` ตรงตัวอักษร ไว้กันเอาไฟล์ Kubernetes จริงมาใส่ผิดที่

### metadata.name

ชื่อของ deployment นี้ ใช้เป็นชื่อไฟล์บนเครื่องปลายทาง:

- `~/EndFroZen/SunCurved/deployments/<name>.yaml` — ตัว YAML
- `~/EndFroZen/SunCurved/state/<name>` — สถานะล่าสุด เช่น `v1.2.0 ok 2026-11-05 14:03:11`

กฎ: ตัวพิมพ์เล็ก a-z, ตัวเลข 0-9 และ `-` เท่านั้น ห้ามขึ้นต้นหรือลงท้ายด้วย `-` ยาวไม่เกิน 63 ตัว

| ชื่อ | ผล |
| --- | --- |
| `ssw-icare` | ✅ |
| `app2` | ✅ |
| `SSW-iCare` | ❌ มีตัวใหญ่ |
| `my_app` | ❌ มี `_` |
| `-app` | ❌ ขึ้นต้นด้วย `-` |

**ระวัง:** Apply ด้วยชื่อเดิม = เขียนทับไฟล์เดิม เปลี่ยนชื่อ = ได้ deployment ใหม่ (อันเก่ายังอยู่ ลบเองด้วย ⋯ → ลบ deployment นี้)

## 4. spec.envFrom และ spec.sudo

### envFrom — ไฟล์ตัวแปรบนเครื่องปลายทาง

```yaml
spec:
  envFrom: ~/EndFroZen/CommandCenter/endfrozen.env
```

สคริปต์จะรัน `set -a; . "<ไฟล์>"; set +a` ก่อนทุกอย่าง ตัวแปรทุกตัวในไฟล์จึงถูก export ให้คำสั่ง build และ git ใช้ได้

ตัวอย่างไฟล์ (อยู่บนเครื่อง server ไม่ได้อยู่ในแอป):

```bash
GITHUB_USERNAME=sukkla01
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
NODE_ENV=production
```

- `~/` ใช้ได้ ถูกแปลงเป็น `$HOME/`
- ไฟล์ต้องเป็น bash ที่ถูกต้อง ห้ามมีช่องว่างรอบ `=`; ค่าที่มีช่องว่างต้องใส่ `"..."`
- ไม่มีไฟล์ → deploy พังตั้งแต่บรรทัดแรก
- **ความลับอยู่บนเครื่องนั้นเท่านั้น** แอปไม่อ่าน ไม่เก็บ และไม่ส่งค่าเหล่านี้กลับมา ให้ `chmod 600` ไฟล์นี้

### sudo — ใช้ sudo ได้หรือไม่

| ค่า | ความหมาย |
| --- | --- |
| `none` (ค่าเริ่มต้น) | ไม่ใช้ sudo; ใช้ `mounts` ไม่ได้ |
| `login-password` | ใช้รหัสผ่านที่บันทึกไว้ตอนสร้าง connection เป็นรหัส sudo |

เมื่อเป็น `login-password` แอปจะดึงรหัสจาก Windows Credential Manager ตอนกด Apply แล้วส่งเข้าสคริปต์ทาง stdin (ไม่อยู่ใน argument จึงไม่โผล่ใน `ps`) คำสั่ง sudo รันผ่าน `printf '%s\n' "$SUDO_PW" | sudo -S -p ''`

เงื่อนไข:

- รหัส sudo ของ user ต้อง**ตรงกับ**รหัส login ที่บันทึก
- ถ้า connection ใช้ key file ค่าที่บันทึกคือ passphrase ของ key ไม่ใช่รหัส sudo — กรณีนี้ใช้ `sudo: none` แล้วตั้ง NOPASSWD ใน sudoers สำหรับ `mount`/`umount` แทน
- ตอนนี้แอปใช้ sudo เฉพาะ `mounts` ถ้าคำสั่งใน `build` เรียก `sudo` เอง จะไม่มีใครป้อนรหัสให้ (stdin เป็น /dev/null) และจะ error

## 5. spec.source — repo, auth, version

### repo

| เขียน | ใช้จริง |
| --- | --- |
| `github.com/sukkla01/sprdd-ext` | `https://github.com/sukkla01/sprdd-ext.git` |
| `github.com/sukkla01/sprdd-ext.git` | `https://github.com/sukkla01/sprdd-ext.git` |
| `https://gitlab.example.com/a/b.git` | ตามที่เขียน (มี scheme) |
| `git@github.com:sukkla01/sprdd-ext.git` | ตามที่เขียน (มี `@` = SSH) |
| `file:///srv/repos/app.git` | ตามที่เขียน |

ถ้าไม่มี scheme และไม่มี `@` แอปจะเติม `https://` หน้าและ `.git` ท้ายให้

**ห้ามใส่ token ใน URL** เช่น `https://ghp_xxx@github.com/...` — มันจะไปอยู่ในไฟล์ YAML และใน log ให้ใช้ `auth` แทน

### auth (ไม่บังคับ — repo public หรือใช้ SSH key ไม่ต้องใส่)

```yaml
    auth: { user: GITHUB_USERNAME, token: GITHUB_TOKEN }
```

ค่าที่ใส่คือ**ชื่อตัวแปร** ใน `envFrom` ไม่ใช่ค่าจริง (ต้องขึ้นต้นด้วยตัวอักษรหรือ `_` ตามด้วยตัวอักษร ตัวเลข `_`) git จะได้ username/password ผ่าน credential helper ที่อ่านตัวแปรตอนรัน token จึงไม่อยู่ใน URL ไม่อยู่ในคำสั่ง และไม่อยู่ใน `.git/config`

GitHub: token ต้องมีสิทธิ์อ่าน repo (fine-grained: Contents = Read)

### version

| ค่า | พฤติกรรม |
| --- | --- |
| `tag` (ค่าเริ่มต้น) | ตอน Apply แอปรัน `git ls-remote --tags` แล้วให้เลือก tag ใน popup (ใหม่สุดอยู่บน เรียงแบบ version: v1.10.0 > v1.9.0) |
| ชื่อ tag เช่น `"v1.2.0"` | ล็อกไว้ที่ tag นั้น popup แสดงตัวเลือกเดียว |

ข้อควรรู้:

- `version` ใช้กับ **tag** เท่านั้น ใส่ commit hash ไม่ได้ ถ้า project ไม่มี tag ให้ใช้ `branch` แทน (ดูด้านล่าง)
- tag ต้อง push ขึ้น remote แล้ว: `git tag v1.2.0 && git push origin v1.2.0`
- ใส่ `"..."` ครอบ version ที่ดูเหมือนตัวเลข เช่น `"1.10"`
- checkout tag ทำให้ repo อยู่ในสถานะ detached HEAD เป็นเรื่องปกติ

### branch — project ที่ไม่มี tag (git pull)

```yaml
  source:
    repo: github.com/me/api
    branch: main
```

- ตอน Apply ไม่ต้องเลือก tag ระบบจะดึง commit ล่าสุดของ branch นั้นมาเลย
- ทำงานเหมือน `git pull --ff-only` แต่ดึงจาก `spec.source.repo`: `fetch` → `checkout <branch>` → `merge --ff-only`
- ถ้า branch บนเครื่องมี commit ที่ไม่มีบน remote (diverged) จะหยุด ไม่ merge ให้ ต้องแก้เองใน Terminal
- state จะบันทึกเป็น `main@a1b2c3d ok <วันเวลา>`
- ใส่ `version` กับ `branch` พร้อมกันไม่ได้ ในโหมดง่ายให้เลือกชิป **git pull branch**

## 6. spec.targets — ทุก field

แต่ละ target = โฟลเดอร์ git หนึ่งตัวบนเครื่องปลายทาง ทำทีละตัว**ตามลำดับที่เขียน** (เช่น project หลักก่อน แล้ว sub project) ทุก target deploy tag เดียวกัน จาก repo เดียวกัน

| field | บังคับ | ค่าเริ่มต้น | ทำอะไร |
| --- | --- | --- | --- |
| `name` | ✅ | — | ชื่อใน log กฎเดียวกับ metadata.name |
| `path` | ✅ | — | โฟลเดอร์ที่ clone ไว้แล้ว (`~/` ได้) |
| `dirty` | — | `ask` | ทำอะไรเมื่อมีไฟล์แก้ค้าง |
| `build` | — | ไม่ build | คำสั่ง bash รันใน `path` |
| `pm2` | — | ไม่เช็ค | ชื่อ process pm2 ที่จะรายงานสถานะ |
| `mounts` | — | ไม่มี | bind mount (ต้อง `sudo: login-password`) |

### steps — ทำอะไร ลำดับไหนก็ได้

```yaml
    - name: main
      path: ~/EndFroZen/project/anima_dashboard
      dirty: ask
      steps:
        - unmount: public/cache
        - checkout
        - run: npm ci
        - run: ./build.sh
        - mount: { from: /data/cache, to: public/cache }
        - pm2: { app: anima-dashboard, do: restart }
        - log: deploy $TAG เสร็จแล้ว เช็คหน้าเว็บด้วย
```

| ขั้นตอน | ทำอะไร |
| --- | --- |
| `checkout` | ดึง tag ที่เลือก (หรือ git pull ถ้าใช้ `branch`) ใช้ `dirty` ของ target ใส่ได้ครั้งเดียว |
| `run: <คำสั่ง>` | รันคำสั่ง bash ใน path หลายบรรทัดใช้ `|` ได้ |
| `unmount: <to>` | ถอด mount ถ้า mount อยู่ (ต้อง `sudo: login-password`) |
| `mount: { from, to }` | `mount --bind` แล้วเช็คว่าติด (ต้อง `sudo: login-password`) |
| `pm2: { app, do }` | `do` = `restart` / `reload` / `status` (ค่าเริ่มต้น status) แล้วพิมพ์สถานะ |
| `log: <ข้อความ>` | เขียนข้อความลง Deploy log เป็นสีฟ้า ขึ้นต้นด้วย `## ` ใช้ `$TAG` `$BRANCH` หรือตัวแปรจากไฟล์ env ได้ หลายบรรทัดใช้ `|` ได้ ไม่นับเป็นขั้นตอน (ไม่ขึ้นใน Flow) |

| `if: { run, then, else }` | รัน `run` เป็นเงื่อนไข (ใน path) จบด้วย exit 0 = **ผ่าน** ทำ `then` / พัง = **ไม่ผ่าน** ทำ `else` แล้ว deploy **ไปต่อ** (ไม่หยุด) ใส่ if ซ้อนกันได้ ใส่ `checkout` ข้างในไม่ได้ |
| `fail: <ข้อความ>` | หยุด deploy ตรงนี้ พิมพ์ `!! ข้อความ` และบันทึกว่าล้มเหลว (ใช้คู่กับ `else`) |

ทำจากบนลงล่าง ขั้นไหนพัง = หยุด log จะแสดงเป็น `==> main: npm ci`

#### if — เช็ค build ไม่ผ่าน หรือเงื่อนไขที่ตั้งเอง

```yaml
      steps:
        - checkout
        - if:
            run: ./build.sh                 # เงื่อนไข = คำสั่งอะไรก็ได้
            then:                           # build ผ่าน
              - pm2: { app: my-app, do: restart }
            else:                           # build ไม่ผ่าน
              - log: build $TAG ไม่ผ่าน ใช้ตัวเดิมต่อ
              - run: git checkout -q -      # กลับไป commit ก่อนหน้า
              - fail: build ไม่ผ่าน          # อยากให้นับว่า deploy ล้มเหลวด้วย (ไม่ใส่ = สำเร็จ)
```

ตัวอย่างเงื่อนไขที่ตั้งเอง: `test -f dist/index.html` (มีไฟล์ไหม), `[ "$TAG" != v0.0.0 ]`, `curl -fs localhost:3000/health`, `! git diff --quiet HEAD@{1} -- package.json` (package.json เปลี่ยน) ไม่ใส่ `then` หรือ `else` ก็ได้ (แต่ต้องมีอย่างใดอย่างหนึ่ง)

เงื่อนไขหลายบรรทัด (`|`) พังที่บรรทัดไหน = ไม่ผ่านทันที บรรทัดที่เหลือไม่ทำ ใน Flow ขั้นตอนของทางที่ไม่ได้ไปจะขึ้นเป็นเส้นประขีดฆ่า และมีปุ่ม Simulate ทั้งแบบ "ผ่าน" และ "ไม่ผ่าน" ในโหมดง่ายกด **+ if** แล้วเพิ่มขั้นตอนใต้ "ถ้าผ่าน" / "ถ้าไม่ผ่าน" ได้เลย หรือกดปุ่ม ↳ (ย้าย) ที่ขั้นตอนไหนก็ได้: ย้ายเข้า "ถ้าผ่าน" / "ถ้าไม่ผ่าน" ของ if ไหนก็ได้, ย้ายออกจาก if, หรือที่ขั้นตอนคำสั่ง (เช่น `npm run build`) เลือก "ใช้คำสั่งนี้เป็นเงื่อนไข if" ได้ทันที

"build ไม่ผ่าน" ดูจาก **exit code** ไม่ต้องใช้ `2>&1` (อันนั้นแค่รวม error เข้ากับ output ที่พิมพ์ออกมา) `npm run build`, `tsc`, `vite build` ฯลฯ จบด้วย exit ไม่ใช่ 0 เองเมื่อพัง ถ้าเป็นสคริปต์ .sh ที่เขียนเอง ให้มี `set -e` บนสุด หรือ `exit 1` ตอนพัง ไม่งั้นจะได้ exit ของบรรทัดสุดท้าย

**แบบเก่ายังใช้ได้:** target ที่ไม่มี `steps` แต่มี `build` / `mounts` / `pm2` จะทำตามลำดับเดิม (unmount → checkout → build → mount → pm2 status) ใส่ `steps` คู่กับ key แบบเก่าในตัวเดียวกันไม่ได้ ในโหมดง่าย พอแก้ขั้นตอนครั้งแรก ระบบจะแปลงเป็น `steps` ให้เอง

### path

ต้องเป็น git repo ที่มีอยู่แล้ว แอป**ไม่ clone ให้** ครั้งแรกให้ clone เองใน Terminal: `git clone https://github.com/x/y.git ~/Projects/y` สคริปต์ fetch จาก `spec.source.repo` เสมอ (ไม่ใช้ `origin`)

### dirty

"dirty" = `git status --porcelain` ไม่ว่าง รวมไฟล์ใหม่ที่ยังไม่ track (`??`) ด้วย ยกเว้นที่อยู่ใน `.gitignore`

| ค่า | พฤติกรรม |
| --- | --- |
| `ask` | popup ตอน Apply แสดงไฟล์ที่แก้ (15 บรรทัดแรก) และต้องติ๊ก "discard" ก่อนถึงจะกด Deploy ได้ |
| `discard` | ทิ้งเลยไม่ถาม: `git reset --hard` + `git clean -fd` |
| `fail` | หยุด deploy ทันที ไม่แตะอะไร |

`git clean -fd` ลบไฟล์ untracked ทิ้งจริง แต่ไม่ลบไฟล์ใน `.gitignore` (เช่น `node_modules`, `.env`) ใช้ `discard` กับโฟลเดอร์ที่ไม่มีใครแก้มือเท่านั้น

### build

คำสั่ง bash อะไรก็ได้ รันหลัง `cd <path>` หลายบรรทัดใช้ `|` ได้ อยู่ใน `set -Eeo pipefail` คำสั่งไหนพัง = หยุด

```yaml
      build: |
        npm ci
        npm run build
        pm2 reload ssw-icare || pm2 start npm --name ssw-icare -- start
```

- **PATH เหมือน Terminal อัตโนมัติ** ก่อนเริ่ม แอปจะถาม PATH จาก `bash -i` (โหลด `~/.bashrc` แบบเดียวกับตอนเปิด Terminal) แล้วใช้ค่านั้น ดังนั้น Go, node/npm/pm2 จาก nvm ที่พิมพ์ใน Terminal ได้ ก็ใช้ใน deploy ได้เลย ไม่ต้องตั้งอะไรเพิ่ม
  - ถ้า `.bashrc` มีปัญหา (error, ค้างเกิน 10 วิ) PATH จะเป็นค่าเดิมของ login shell และ deploy ยังทำงานต่อ
  - ถ้าตั้ง `PATH=...` ไว้ในไฟล์ env ค่านั้นจะถูกใช้ทับ (ไฟล์ env โหลดทีหลัง)
  - ยังเจอ `command not found` หรือ Go/node ผิดเวอร์ชัน: ลองเพิ่มขั้นตอน `which go node pm2; go version` แล้วเทียบกับผลใน Terminal
- **stdin เป็น /dev/null** คำสั่งที่ถาม (y/n, รหัส) จะได้ EOF ให้ใช้ flag แบบไม่ถาม เช่น `-y`
- สคริปต์เดิม เช่น `./ssw-icare-builder.sh` ก็เรียกตรงๆ ได้
- ถ้าทำ `cd` ใน build ตัวต่อไปจะ `cd` กลับเอง ไม่ต้องกังวล
- ต้องสลับ nginx (blue/green) ก็เรียกสคริปต์สลับของคุณใน build ตรงๆ เช่น `~/switch-3001.sh` (ดูตัวอย่าง 8.4)

### pm2

แค่**รายงาน**สถานะ (`pm2 describe <ชื่อ>` บรรทัด status/version) **ไม่ restart ให้** หากไม่เจอก็แค่พิมพ์ `pm2: <ชื่อ> not found` ไม่ทำให้พัง ต้องการ reload ให้ใส่ใน `build`

### mounts

```yaml
      mounts:
        - from: /home/ict016/Document/merge-file   # ต้นทาง (path เต็มหรือ ~/)
          to: public/merged-cache                   # ปลายทาง นับจาก path
```

- `to` ที่ไม่ขึ้นต้นด้วย `/` หรือ `~` นับจาก `path` ของ target
- ก่อน checkout: ถ้า `to` เป็น mountpoint อยู่ → `umount` (ไม่งั้น git จะเห็นไฟล์จาก mount)
- หลัง build: `mkdir -p <to>` → `mount --bind <from> <to>` → เช็คด้วย `mountpoint` ถ้าไม่ติด = พัง
- mount แบบนี้หายเมื่อ reboot ต้อง Apply ใหม่ (หรือใส่ `/etc/fstab` เอง)
- ให้ใส่ `to` ใน `.gitignore` ของ repo ไม่งั้นโฟลเดอร์ที่ `mkdir` สร้างจะทำให้ dirty

## 7. ลำดับการทำงานจริง และเมื่อพัง

สคริปต์ที่ compile ออกมาทำตามลำดับนี้เสมอ ไม่ว่าคุณจะเขียน key สลับที่กันใน YAML แค่ไหน:

**ส่วนหัว (ครั้งเดียว)**

1. `set -Eeo pipefail` + ตั้ง trap ERR
2. สร้าง `~/EndFroZen/SunCurved/state/`
3. (ถ้า `sudo: login-password`) เตรียม `sudo_cmd`
4. (ถ้ามี `envFrom`) โหลดไฟล์ env
5. ตั้ง `GIT_URL` และ `git_auth`

**ต่อ target (ตามลำดับใน list)**

| # | ขั้นตอนใน log | ทำเมื่อ |
| --- | --- | --- |
| 1 | `==> <name>: unmount` | มี `mounts` |
| 2 | `==> <name>: checkout $TAG` | ทุกครั้ง (เช็ค dirty → fetch tag → checkout → พิมพ์ commit) |
| 3 | `==> <name>: build` | มี `build` |
| 4 | `==> <name>: mount` | มี `mounts` |
| 5 | `==> <name>: pm2 <app>` | มี `pm2` |

**ท้าย:** `==> DEPLOYMENT SUCCESS` พิมพ์ Tag แล้วเขียน state `<tag> ok <วันเวลา>`

### เมื่อคำสั่งใดพัง

คำสั่งแรกที่ exit ไม่เป็น 0 จะหยุดทั้งสคริปต์ทันที (target ที่เหลือไม่ถูกแตะ) แล้วพิมพ์:

```text
!! FAILED at: main: build
```

- `FAILED at` = ชื่อขั้นตอนล่าสุด (ตรงกับบรรทัด `==>` ด้านบน) เลื่อนขึ้นไปดู output ก่อนหน้านั้นเพื่อหาสาเหตุ
- state เปลี่ยนเป็น `<tag> failed <วันเวลา>` และรายการด้านซ้ายแสดงสถานะนี้
- **ไม่มี rollback อัตโนมัติ** — repo อาจค้างอยู่ที่ tag ใหม่ที่ build ไม่ผ่าน แก้แล้ว Apply ใหม่ (tag เดิมหรือ tag เก่าที่ใช้ได้)
- mount ที่ถูก unmount ไปแล้วจะยังไม่ถูก mount กลับ จนกว่า Apply จะผ่านขั้น mount

ข้อยกเว้น: คำสั่งที่อยู่หลัง `||`, ใน `if`, หรือในฟังก์ชันที่จับ error เอง จะไม่ทำให้หยุด (ตามกฎของ bash `set -e`)

## 8. ตัวอย่างพร้อมใช้

### 8.1 เล็กที่สุดที่ทำงานได้

repo public, ไม่มี build — แค่ checkout tag:

```yaml
apiVersion: suncurved/v1
kind: Deployment
metadata:
  name: docs-site
spec:
  source:
    repo: github.com/me/docs-site
  targets:
    - name: main
      path: ~/www/docs-site
```

### 8.2 Node app + pm2, repo private

```yaml
apiVersion: suncurved/v1
kind: Deployment
metadata:
  name: api
spec:
  envFrom: ~/EndFroZen/CommandCenter/endfrozen.env
  source:
    repo: github.com/me/api
    auth: { user: GITHUB_USERNAME, token: GITHUB_TOKEN }
  targets:
    - name: api
      path: ~/Projects/api
      dirty: fail
      build: |
        npm ci
        npm run build
        pm2 reload api
      pm2: api
```

### 8.3 ล็อก version ตายตัว

```yaml
  source:
    repo: github.com/me/api
    version: "v2.4.1"
```

popup ตอน Apply จะมีตัวเลือกเดียวคือ `v2.4.1`

### 8.4 เต็มรูปแบบ — แปลงจาก ssw-icare-controller.sh

เทียบเท่าสคริปต์เดิม: unmount cache → checkout → สลับไป 3001 + build + สลับกลับ 3000 (ใน build) → mount → ทำ sub project ต่อ

```yaml
apiVersion: suncurved/v1
kind: Deployment
metadata:
  name: ssw-icare
spec:
  envFrom: ~/EndFroZen/CommandCenter/endfrozen.env
  sudo: login-password
  source:
    repo: github.com/sukkla01/sprdd-ext
    auth: { user: GITHUB_USERNAME, token: GITHUB_TOKEN }
    version: tag
  targets:
    - name: main
      path: ~/Projects/ssw-icare
      dirty: ask
      build: |
        ~/EndFroZen/CommandCenter/switch-3001.sh
        ./ssw-icare-builder.sh
        ~/EndFroZen/CommandCenter/switch-3000.sh
      pm2: ssw-icare
      mounts:
        - from: /home/ict016/Document/merge-file
          to: public/merged-cache
    - name: switch
      path: ~/Projects/ssw-icare-switch
      dirty: ask
      build: ./ssw-icare-builder.sh
      pm2: ssw-icare-switch
```

ปรับ path, ชื่อ pm2 และ path ของ mount ให้ตรงกับเครื่องจริงก่อน Apply ครั้งแรก — กดแท็บ **sh** เทียบกับสคริปต์เดิมได้ทีละบรรทัด

เทียบสิ่งที่เปลี่ยนจากสคริปต์เดิม:

| สคริปต์เดิม | ตอนนี้ |
| --- | --- |
| token ใส่ใน URL ของ git | credential helper อ่านจาก env ตอนรัน |
| `echo $SUDO_PASSWORD \| sudo -S` จากไฟล์ env | รหัส login ที่เก็บใน Credential Manager ส่งผ่าน stdin |
| `read -p` เลือก tag ใน terminal | popup เลือก tag ในแอป |
| ถาม y/n ตอน dirty | checkbox ใน popup |

## 9. ใช้ editor ในแอป

เข้าเครื่อง → ปุ่ม **Deploy** → หน้า Deploy: ด้านซ้ายเป็นรายการ deployment บนเครื่องนั้น (พร้อมสถานะ ok / failed / never) ด้านขวาเป็น editor และ log

### โหมดง่าย (ฟอร์ม) กับโหมด YAML

ปุ่ม **[ ง่าย | YAML ]** บนแถบเครื่องมือใช้สลับวิธีแก้ ทั้งสองโหมดแก้ไฟล์เดียวกัน แก้ในฟอร์มแล้ว YAML เปลี่ยนตามทันที แอปจำโหมดล่าสุดที่ใช้ไว้ให้

| ในฟอร์ม | ได้ใน YAML |
| --- | --- |
| ปุ่มโฟลเดอร์ข้างช่อง Path / ไฟล์ env / mount | เปิดหน้าต่างเลือกโฟลเดอร์หรือไฟล์บนเครื่อง ได้ path แบบ `~/...` |
| **+ คำสั่ง** / **+ unmount** / **+ mount** / **+ pm2** / **+ if** / **+ หยุด** | เพิ่มขั้นตอนใน `steps` (mount/unmount เปิด sudo ให้อัตโนมัติ) if มีรายการ "ถ้าผ่าน" / "ถ้าไม่ผ่าน" ของตัวเอง |
| **+ สคริปต์ .sh** | เลือกไฟล์บนเครื่องแล้วเพิ่มเป็นขั้น `run` (ถ้าอยู่ใน path ของ target จะได้ `./ชื่อไฟล์`) |
| ลากป้ายหน้าขั้นตอน | เรียงลำดับขั้นตอนใหม่ (หรือใช้ลูกศรขึ้น/ลงที่โผล่ตอนชี้) |
| **+ เพิ่ม target** | เพิ่ม project ถัดไปใน `targets` |
| ช่องชื่อ process ของ pm2 | มีรายชื่อจาก `pm2 jlist` บนเครื่องให้เลือก ถ้าเครื่องไม่ได้ติดตั้ง pm2 ปุ่ม **+ pm2** จะกดไม่ได้ และแถว pm2 ที่มีอยู่จะขึ้นเตือนสีแดง (ไม่ไปเปิด pm2 daemon ให้) |
| ติ๊ก Repo private | ใส่ `auth` ช่อง user/token มีรายชื่อตัวแปรจากไฟล์ env ให้เลือก (อ่านแค่ชื่อ ไม่อ่านค่า) |

- ช่องที่ผิดจะมีกรอบสีแดง และมีข้อความบอกใต้แถบเครื่องมือเหมือนโหมด YAML
- comment ที่เขียนไว้ใน YAML ยังอยู่ ยกเว้นของที่ลบทิ้งในฟอร์ม
- ถ้า YAML พิมพ์ผิดจนอ่านไม่ได้ (เช่นย่อหน้าเพี้ยน) จะเปิดโหมดง่ายไม่ได้ ต้องแก้ในโหมด YAML ก่อน
- ช่องว่างในฟอร์ม = ไม่ใส่ key นั้นใน YAML

### คำแนะนำอัตโนมัติ

คำแนะนำรู้ว่า cursor อยู่ตรงไหนในโครงสร้าง (ดูจากการย่อหน้า) และเสนอเฉพาะ key ที่ใช้ได้ตรงนั้น

| ทำ | ได้ |
| --- | --- |
| พิมพ์ตัวอักษรต้นบรรทัด | รายชื่อ key ของระดับนั้น พร้อมคำอธิบาย |
| พิมพ์ ` key:  ` (หลังช่องว่าง) | ค่าที่ใช้ได้ เช่น `sudo:` → login-password / none, `dirty:` → ask / discard / fail |
| **Ctrl+Space** บนบรรทัดว่าง | เปิดรายการเอง (บรรทัดว่างจะไม่เด้งเอง ไม่กวนตอนพิมพ์) |
| ↑ ↓ แล้ว Enter | ใส่คำที่เลือก / Esc ปิด |

### Snippet

คำที่มีป้าย `snippet` ใส่ทั้งก้อนพร้อมช่องให้กรอก กด **Tab** กระโดดไปช่องถัดไป:

- `- target` — ใน `targets:` ใส่ target ใหม่พร้อม name / path
- `- mount` — ใน `mounts:` ใส่ from / to
- `metadata`, `spec`, `source`, `targets` ฯลฯ — ใส่ key พร้อมโครงข้างใน

### ปุ่มลัด

| ปุ่ม | ทำ |
| --- | --- |
| Tab / Shift+Tab | ย่อ / ถอยหน้า 2 ช่อง (เลือกหลายบรรทัดได้) |
| Ctrl+/ | เปิด/ปิด comment |
| Ctrl+F | ค้นหา / แทนที่ |
| Ctrl+Z / Ctrl+Shift+Z | undo / redo |
| Alt+↑ / Alt+↓ | ย้ายบรรทัด |

### ตรวจทันทีที่พิมพ์

ทุกครั้งที่แก้ แอปรันตัวตรวจตัวเดียวกับตอน Apply แล้วแสดง error สีแดงใต้แถบเครื่องมือ (ดูความหมายในหัวข้อ 10) ไม่มี error = พร้อม Apply

### แถบเครื่องมือ

`ฟอร์ม | YAML ┆ Flow | sh`   📖   ⋯   **Apply**

| ส่วน | ทำ |
| --- | --- |
| **ฟอร์ม** / **YAML** | โหมดแก้ไข (จำไว้ว่าชอบแบบไหน) |
| **Flow** | ดูขั้นตอนเป็นแผนผัง 3D (isometric: บล็อกต่อด้วยท่อ, if แตกเป็นสองทาง) หรือสลับเป็น "รายการ" ได้มุมขวาบน คลิกบล็อกดูคำสั่ง กด Simulate ได้ ตอน Apply จะติดไฟตาม |
| **sh** | สคริปต์ bash ที่จะรันจริง (อ่านอย่างเดียว) tag แสดงเป็น `<chosen at deploy>` รหัส sudo แสดงเป็น `********` กด ฟอร์ม/YAML เพื่อกลับไปแก้ |
| 📖 | คู่มือนี้ |
| ⋯ | **Save sh ลงเครื่อง** และ **ลบ deployment นี้** (กดสองครั้งเพื่อยืนยัน) |
| **Apply** | deploy ตัวที่เปิดอยู่ |

### Apply หลายตัว (คิว)

ในรายการ Deployments ด้านซ้าย เอาเมาส์ไปชี้แล้วกดวงกลมหน้าชื่อเพื่อเลือก ตัวเลขในวงกลม = ลำดับที่จะรัน (ตามลำดับที่กด) ด้านล่างจะมีแถบคิว:

- **ทั้งหมด** / **ล้าง** — เลือกทุกตัว / เอาออกหมด
- **ถ้าตัวไหนพัง** — **หยุดคิว** (ตัวที่เหลือไม่รัน) หรือ **ข้ามไปตัวถัดไป** (จำค่าไว้)
- **Apply N ตัวตามลำดับ**

ขั้นแรกจะถาม popup (เลือก tag / discard) ของ**ทุกตัวให้ครบก่อน** หัว popup บอกลำดับ เช่น `[2/3]` กด Cancel = ข้ามตัวนั้น จากนั้นรัน**ทีละตัว**ต่อกันเอง ไม่ต้องเฝ้า วงกลมเปลี่ยนสีตามผล (ส้ม = กำลังรัน, เขียว = สำเร็จ, แดง = ล้มเหลว, จาง = ไม่ได้รัน) และ log จบด้วยสรุป `queue done: …`

- ตัวที่เปิดอยู่ในตัวแก้ ใช้เนื้อหาในตัวแก้ (บันทึกให้ก่อนเหมือน Apply) และหน้า Flow จะติดไฟตอนถึงคิวมัน ตัวอื่นใช้ไฟล์ที่บันทึกไว้บนเครื่อง
- รันทีละตัวเพราะเครื่องเดียวรันคำสั่งได้ทีละอัน (build พร้อมกันยังแย่ CPU/RAM กันด้วย) คนละเครื่อง (คนละแท็บ) Apply พร้อมกันได้

### Apply — สิ่งที่เกิดขึ้น

1. ตรวจ YAML (ผิด = ไม่ส่งอะไรเลย)
2. บันทึกไฟล์ไป `~/EndFroZen/SunCurved/deployments/<name>.yaml`
3. precheck: ดึงรายการ tag + เช็ค target ที่ dirty
4. popup: เลือก tag (บนสุด = latest) และติ๊ก discard สำหรับ target ที่ `dirty: ask` — กด Cancel ได้ (ไฟล์ถูกบันทึกไปแล้วแต่ไม่ได้รัน)
5. สร้างสคริปต์จริง ส่งเข้า `bash -l -s` บนเครื่องนั้น
6. log ไหลเข้ามาแบบสด: บรรทัด `==>` = ขั้นตอน, `!!` = พัง (สีแดง)

### Save sh

เขียนสคริปต์ไปที่ `~/EndFroZen/SunCurved/scripts/<name>.sh` (`chmod 700` อ่าน/รันได้แค่ user นั้น) เพื่อเอาไปรันเองใน Terminal:

```bash
~/EndFroZen/SunCurved/scripts/<name>.sh v1.2.0    # version: tag ต้องใส่ tag
~/EndFroZen/SunCurved/scripts/<name>.sh           # branch หรือ tag ที่ล็อกไว้
```

ต่างจากตอน Apply:
- **ไม่มีรหัส sudo ในไฟล์** — mount/unmount จะให้ sudo ถามรหัสใน Terminal เอง
- `dirty: ask` จะถาม `discard these changes in main? [y/N]` ใน Terminal
- PATH ได้จาก `~/.bashrc` เหมือนตอนกด Deploy
- output อยู่ใน Terminal ไม่ขึ้นใน Deploy log และหน้า Flow ไม่ติดไฟ แต่ state ยังถูกบันทึกเหมือนเดิม
- กด ⋯ → Save sh ใหม่ทุกครั้งที่แก้ YAML ไฟล์เดิมไม่อัปเดตเอง

### ลบ deployment (⋯ → ลบ deployment นี้)

ลบเฉพาะไฟล์ของ Sun Curved (`deployments/<name>.yaml`, `state/<name>` และ `scripts/<name>.sh`) **ไม่แตะโฟลเดอร์ project, mount หรือ pm2**

## 10. Error ทั้งหมดและวิธีแก้

### Error ตอนเขียน (แสดงใต้แถบเครื่องมือ)

| ข้อความ | สาเหตุ | แก้ |
| --- | --- | --- |
| `YAML: ...` | ไวยากรณ์ YAML ผิด เช่น ใช้ Tab, ย่อหน้าไม่ตรง, ลืมช่องว่างหลัง `:`, key ซ้ำ | ดูข้อความต่อท้ายที่บอกบรรทัด/คอลัมน์ แล้วดูหัวข้อ 2 |
| `apiVersion must be "suncurved/v1"` | ไม่มีหรือพิมพ์ผิด | `apiVersion: suncurved/v1` |
| `kind must be "Deployment"` | ไม่มีหรือพิมพ์ผิด (ตัว D ใหญ่) | `kind: Deployment` |
| `metadata.name: lowercase letters, digits and '-' only` | ไม่มีชื่อ หรือมีตัวใหญ่ / `_` / ช่องว่าง | เช่น `my-app` |
| `spec.sudo must be "login-password" or "none"` | ค่าอื่น เช่น `yes` | เลือกหนึ่งในสองค่า |
| `spec.source.repo is required` | ไม่มี `source.repo` | ใส่ repo |
| `spec.source.auth: user/token must be env var names` | ใส่ค่า token จริงหรือชื่อที่มี `-` | ใส่ชื่อตัวแปรใน envFrom เช่น `GITHUB_TOKEN` |
| `spec.source: use either version (tags) or branch (git pull), not both` | ใส่ทั้ง version และ branch | เลือกอย่างเดียว |
| `spec.source.branch: not a valid branch name` | ชื่อ branch มีช่องว่างหรือตัวอักษรแปลก | เช่น `main`, `release/1.x` |
| `spec.targets: at least one target` | ไม่มี `targets` หรือว่าง | เพิ่ม `- name: ... path: ...` |
| `spec.targets[0].name: ...` | target ไม่มีชื่อหรือชื่อผิดกฎ | กฎเดียวกับ metadata.name |
| `spec.targets[0].dirty: ask \| discard \| fail` | ค่าผิด | เลือกหนึ่งในสาม |
| `spec.targets[0].mounts need spec.sudo: login-password` | มี mounts แต่ sudo เป็น none | ตั้ง `sudo: login-password` |
| `spec.targets[0].path is required` | ไม่มี path | ใส่ path |
| `spec.targets[0].mounts[0].from is required` (หรือ `to`) | mount ไม่ครบ | ใส่ทั้ง from และ to |

`[0]` = ลำดับเริ่มจาก 0 คือ target ตัวแรก, `[1]` คือตัวที่สอง

### Error ตอน Apply

| เห็นใน log | สาเหตุที่พบบ่อย | แก้ |
| --- | --- | --- |
| `no tags found` | repo ไม่มี tag, URL ผิด, หรือ auth ไม่ผ่าน | push tag; เช็ค repo; เช็คตัวแปรใน envFrom |
| `No such file or directory` บรรทัดแรก | ไฟล์ `envFrom` ไม่มี | สร้างไฟล์หรือแก้ path |
| FAILED at `<name>: checkout` + `not discarding` | dirty และไม่ได้เลือก discard | commit/stash เอง หรือติ๊ก discard |
| FAILED at `checkout` + `cd: ... No such file` | path ไม่มี / ยังไม่ clone | clone ก่อน (หัวข้อ 6) |
| FAILED at `checkout` + `Authentication failed` | token ผิด/หมดอายุ/ไม่มีสิทธิ์ | ออก token ใหม่ใส่ในไฟล์ env |
| FAILED at `checkout` + `couldn't find remote ref` | tag ไม่มีบน remote | `git push origin <tag>` |
| FAILED at `build` + `command not found` | ไม่มี node/npm/pm2 แม้ใน Terminal | ติดตั้งให้พิมพ์ใน Terminal ได้ก่อน (deploy ใช้ PATH เดียวกับ Terminal) |
| FAILED at `unmount`/`mount` + `incorrect password` | รหัส sudo ไม่ตรงกับรหัส login ที่เก็บ | แก้รหัสด้วยปุ่ม ✎ หรือใช้ NOPASSWD |
| FAILED at `pull <branch>` + `Not possible to fast-forward` | branch บนเครื่อง diverged จาก remote | แก้ใน Terminal เช่น `git reset --hard origin/<branch>` |
| `mount failed: ...` | from ไม่มีอยู่ | สร้างโฟลเดอร์ต้นทาง |
| FAILED at `build` + `Permission denied` | สคริปต์ที่เรียกใน build ไม่มีสิทธิ์รัน | `chmod +x` |

## 11. ความปลอดภัย ข้อจำกัด และคำถามที่พบบ่อย

### ความปลอดภัย

- รหัสผ่าน connection อยู่ใน **Windows Credential Manager** เท่านั้น ไม่อยู่ใน sqlite ไม่อยู่ใน YAML
- รหัส sudo ส่งเข้าสคริปต์ทาง stdin ไม่อยู่ใน command line (`ps` มองไม่เห็น) และไม่ถูกเขียนลงดิสก์บนเครื่องปลายทาง
- git token อยู่ในไฟล์ env บนเครื่องปลายทาง ใช้ผ่าน credential helper ไม่อยู่ใน URL ไม่อยู่ใน `.git/config`
- รหัส 2FA พิมพ์เองทุกครั้ง ไม่ถูกเก็บ
- YAML ถูกเก็บเป็นข้อความธรรมดาบนเครื่องปลายทาง — **ห้ามใส่ความลับใน YAML** ใส่ในไฟล์ env แล้ว `chmod 600`
- `build` คือคำสั่ง shell เต็มรูปแบบ ใครแก้ YAML ได้ = รันคำสั่งอะไรก็ได้ในนาม user นั้น

### ข้อจำกัดตอนนี้

- ระหว่าง deploy terminal ของเครื่องนั้นจะค้างจนกว่าจะเสร็จ (ใช้ connection เดียวกัน)
- ยังไม่มีปุ่มยกเลิกกลางทาง
- build ถามคำถามไม่ได้ (stdin = /dev/null)
- `sudo: login-password` ใช้ได้เมื่อรหัส sudo = รหัส login เท่านั้น
- deploy ได้จาก tag หรือ branch (git pull), repo เดียวต่อ deployment
- ไม่มี rollback อัตโนมัติ, ไม่ clone ให้, ไม่ restart pm2 ให้ (ใส่ใน build)

### FAQ

**มีไฟล์ .sh ถูกสร้างบนเครื่องไหม?** ตอน Apply ไม่มี สคริปต์ถูกส่งผ่าน stdin เข้า `bash -l -s` ตรงๆ แล้วหายไป ดูได้จากแท็บ sh จะมีไฟล์ก็ต่อเมื่อกด **⋯ → Save sh ลงเครื่อง** เอง

**ทำไมห่อสคริปต์ด้วย `{ ... } < /dev/null`?** เพื่อให้ bash อ่านสคริปต์ทั้งหมดก่อนรัน และกันไม่ให้คำสั่งใน build (เช่น อะไรที่อ่าน stdin) กินส่วนที่เหลือของสคริปต์ไป

**rollback ยังไง?** Apply ใหม่แล้วเลือก tag เก่าที่ใช้ได้ใน popup

**มีหลาย server deploy โปรเจกต์เดียวกัน?** สร้าง deployment ชื่อเดียวกันในแต่ละเครื่อง ไฟล์แยกกันต่อเครื่อง

**แก้ YAML บนเครื่องปลายทางเองได้ไหม?** ได้ แก้ `~/EndFroZen/SunCurved/deployments/<name>.yaml` แล้วกด refresh ในแอป

**อยากรันขั้นตอนที่ไม่มีใน schema?** ใส่ใน `build` ได้ทุกอย่างที่ bash ทำได้

**ดูว่า deploy ล่าสุดคือ tag อะไร?** ดูสถานะข้างชื่อในรายการด้านซ้าย หรือ `cat ~/EndFroZen/SunCurved/state/<name>`
