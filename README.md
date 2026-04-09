# MAX ↔ Chatwoot: Техподдержка для команды

## Что это

Связка из двух сервисов:
- **Chatwoot** — веб-интерфейс для 5 операторов, все чаты в одном окне
- **Bridge** — маленькая программа-посредник между MAX и Chatwoot

Клиент пишет в MAX-бот → Bridge → Chatwoot → оператор отвечает → Bridge → клиент получает ответ в MAX.

---

## Локальный запуск (Docker, Windows/macOS/Linux)

### Требования
- Установленный Docker Desktop (или Docker Engine + Compose)

### Быстрый старт
1) Скопируйте пример переменных окружения:

```bash
cp .env.example .env
```

2) Заполните в `.env` минимум:
- `SECRET_KEY_BASE` (сгенерируйте `openssl rand -hex 32`)
- `FRONTEND_URL` (по умолчанию уже `http://localhost:3001`)
- `MAX_TOKEN`, `CHATWOOT_TOKEN`, `CHATWOOT_ACCOUNT`, `CHATWOOT_INBOX_ID`
 - если порт 3001 занят — поменяйте `CHATWOOT_PORT` (и `FRONTEND_URL`) на свободный, например `3005`

Важно: если вы копировали `.env` вручную, проверьте, что строка выглядит так (без “склейки”):
```
CHATWOOT_URL=http://chatwoot:3000
```

3) Первый запуск (инициализация БД — один раз):

```bash
docker compose run --rm chatwoot bundle exec rails db:prepare
```

4) Поднимите сервисы:

```bash
docker compose up -d postgres redis chatwoot sidekiq
docker compose up -d bridge
```

5) Откройте Chatwoot локально:

```bash
http://localhost:3001
```

### Если получили “port is already allocated”
Это значит, что порт на сервере уже занят (часто — старыми контейнерами).

Быстрый вариант (остановить старые контейнеры этого проекта):

```bash
docker compose down
docker compose up -d
```

Альтернатива (не трогая старые сервисы): смените порт в `.env`, например:
```
CHATWOOT_PORT=3005
FRONTEND_URL=http://localhost:3005
```

---

## Деплой на VPS (как в инструкции ниже)

## Шаг 1. Арендуйте VPS

Минимальные требования: **2 GB RAM, Ubuntu 22.04**

Подходящие провайдеры (300–600 руб/мес):
- timeweb.cloud
- beget.com
- reg.ru (VPS)

После получения VPS подключитесь по SSH:
```bash
ssh root@ВАШ_IP
```

---

## Шаг 2. Установите Docker

```bash
apt update && apt install -y docker.io docker-compose-plugin
systemctl enable docker
systemctl start docker
```

Проверьте:
```bash
docker --version
```

---

## Шаг 3. Загрузите файлы на сервер

На вашем компьютере (или прямо на сервере):
```bash
# Создайте папку и скопируйте все файлы из архива
mkdir -p /opt/max-support
cd /opt/max-support
# Скопируйте сюда: docker-compose.yml, .env, Dockerfile, package.json, index.js и папку src/
```

Если копируете со своего компьютера через scp:
```bash
scp -r ./max-support root@ВАШ_IP:/opt/max-support
```

---

## Шаг 4. Заполните docker-compose.yml

Откройте файл и замените две строки:
```bash
nano /opt/max-support/docker-compose.yml
```

Найдите и замените:
- `SECRET_KEY_BASE` и `FRONTEND_URL` — теперь задаются в `.env` (пример в `.env.example`)

---

## Шаг 5. Первый запуск Chatwoot

```bash
cd /opt/max-support

# Инициализировать базу данных (только один раз!)
docker compose run --rm chatwoot bundle exec rails db:prepare

# Запустить всё
docker compose up -d postgres redis chatwoot sidekiq
```

Подождите 1–2 минуты, затем откройте в браузере:
```
http://ВАШ_IP:3001
```

Создайте аккаунт администратора.

---

## Шаг 6. Настройте Chatwoot

### 6.1 Получите User Access Token
Войдите в Chatwoot → кликните на аватар (внизу слева) → **Profile Settings** → скопируйте **Access Token**

Вставьте его в `.env`:
```
CHATWOOT_TOKEN=скопированный_токен
```

### 6.2 Узнайте ID аккаунта
Посмотрите URL в браузере после входа:
```
http://ВАШ_IP:3001/app/accounts/1/...
                                 ^
                              это и есть CHATWOOT_ACCOUNT
```

### 6.3 Создайте API Inbox
Settings → Inboxes → **Add New Inbox** → выберите **API**

Название: `MAX Support`

После создания посмотрите URL:
```
http://ВАШ_IP:3001/app/accounts/1/settings/inboxes/2/...
                                                    ^
                                               это CHATWOOT_INBOX_ID
```

### 6.4 Настройте Webhook в Chatwoot (для ответов операторов)
Settings → Inboxes → ваш инбокс → **Configuration** → **Webhooks**

URL вебхука:
```
http://bridge:3000/webhook
```

Отметьте галочку: **Message Created**

---

## Шаг 7. Запустите Bridge

После заполнения всех значений в `.env`:

```bash
cd /opt/max-support
docker compose up -d bridge
```

Проверьте логи:
```bash
docker compose logs -f bridge
```

Должны увидеть:
```
🚀 MAX ↔ Chatwoot Bridge запущен
   Chatwoot: http://chatwoot:3000 / account 1 / inbox 1
   Webhook-сервер слушает :3000
```

---

## Шаг 8. Добавьте операторов

Chatwoot → Settings → **Agents** → пригласите 5 сотрудников по email.

Каждый заходит по ссылке из письма, создаёт пароль — и видит все входящие диалоги.

---

## Проверка

1. Напишите что-нибудь своему боту в MAX
2. Откройте Chatwoot — должен появиться новый диалог
3. Ответьте из Chatwoot — ответ должен прийти в MAX

---

## Полезные команды

```bash
# Статус всех сервисов
docker compose ps

# Логи bridge
docker compose logs -f bridge

# Логи chatwoot
docker compose logs -f chatwoot

# Перезапустить bridge после изменений
docker compose restart bridge

# Остановить всё
docker compose down

# Обновить Chatwoot
docker compose pull chatwoot sidekiq
docker compose up -d chatwoot sidekiq
```

---

## Структура файлов

```
max-support/
  docker-compose.yml   ← главный файл, запускает всё
  .env                 ← токены и настройки (не публиковать!)
  Dockerfile           ← сборка bridge-сервиса
  package.json
  index.js             ← код моста MAX ↔ Chatwoot
  src/
```
