# SmaCrossoverTelegram

Тестовая стратегия: **пересечение короткой и длинной SMA** → отправка сообщения в **Telegram** (без сделок).

## Логика

- Считаются две SMA по закрытию свечи: **короткая** (по умолчанию 10) и **длинная** (30).
- При **пересечении снизу вверх** (короткая SMA пересекает длинную снизу) → сигнал **LONG** → событие в Redis → Telegram.
- При **пересечении сверху вниз** → сигнал **SHORT** → то же самое.

Сделки не открываются и не закрываются — только уведомления.

## Запуск

1. В `config/config.detector.json` задать `sysName: "SmaCrossoverTelegram"` или задать переменную окружения:
   ```bash
   set DETECTOR_SYSNAME=SmaCrossoverTelegram
   ```
2. Включить Telegram (для отправки сообщений):
   ```bash
   set DETECTOR_TELEGRAM_ENABLED=1
   set TELEGRAM_CHAT_ID=ваш_chat_id
   set DETECTOR_TELEGRAM_CHAT_ID=ваш_chat_id   # или этот
   ```
   Токен бота задаётся через конфиг Telegram/бот (например `TELEGRAM_BOT_TOKEN` в окружении или в настройках приложения).
3. Запустить detector (Provider должен быть поднят и отдавать свечи по подписке `PROVIDER_MARKETDATA_CANDLE`).

## Параметры (customConfig)

В конфиге инстанса можно задать:

- `shortSmaPeriod` — период короткой SMA (по умолчанию 10).
- `longSmaPeriod` — период длинной SMA (по умолчанию 30).

Интервалы свечей и символы задаются в `detector`-конфиге (по умолчанию BTCUSDT, ETHUSDT и таймфреймы min5, min15).
