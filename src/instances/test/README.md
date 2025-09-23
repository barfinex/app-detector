# 📄 VolumeFollow

VolumeFollow — торговая стратегия для **Barfinex DetectorService**,  
которая анализирует **онлайн-ленту сделок** и **стакан заявок**, выявляет крупные объёмы  
и следует за краткосрочным трендом.

---

## 🇷🇺 Описание (RU)

### 🔹 Логика входа
- Вход возможен только при появлении **крупной сделки (whale trade)**.
- Дополнительные условия:
  - **Дисбаланс стакана** — bid значительно больше ask или наоборот.
  - **Дельта трейдов** — ≥70% покупок или продаж за последние N сделок.
  - **VWAP крупных сделок** — цена входа рядом с уровнем накопления объёмов.

### 🔹 Логика выхода
- **StopLoss**: 0.5% от цены входа.
- **Многоуровневый TakeProfit**:
  - **TP1 (1%)** → фиксируется 25% позиции.
  - **TP2 (2%)** → фиксируется ещё 25%.
  - **TP3 (3%)** → закрывается остаток.
- **TrailingStop**: стоп подтягивается за ценой на 0.5%.
- **Reverse Signal**: закрытие позиции и открытие противоположной при смене потока сделок.
- **Time Limit**: принудительное закрытие позиции через 30 минут.

### 🔹 Состояние
- История последних трейдов (до 200).
- Снимок текущего стакана.
- У позиции сохраняется:
  - Направление (LONG/SHORT).
  - Цена и время входа.
  - Количество контрактов.
  - Уровень TrailingStop.
  - Сработавшие TP.

---

## 🇬🇧 Description (EN)

### 🔹 Entry Logic
- Entry only allowed when a **large trade (whale trade)** is detected.
- Additional conditions:
  - **Order book imbalance** — bids ≫ asks or vice versa.
  - **Trade delta** — ≥70% buys or sells over the last N trades.
  - **VWAP of large trades** — entry near whale accumulation level.

### 🔹 Exit Logic
- **StopLoss**: 0.5% from entry.
- **Multi-level TakeProfit**:
  - **TP1 (1%)** → close 25% of position.
  - **TP2 (2%)** → close another 25%.
  - **TP3 (3%)** → close remaining position.
- **TrailingStop**: follows price by 0.5%.
- **Reverse Signal**: closes and flips position on trade flow reversal.
- **Time Limit**: force exit after 30 minutes.

### 🔹 State Management
- Keeps up to 200 last trades.
- Stores the latest order book snapshot.
- For open position tracks:
  - Direction (LONG/SHORT).
  - Entry price and time.
  - Position size.
  - Current TrailingStop level.
  - Triggered TP flags.

---

## 📊 Flowchart

```mermaid
flowchart TD
    A[Start] --> B{Big Trade?}
    B -- No --> A
    B -- Yes --> C{Confirm: Delta + OB Imbalance + VWAP}
    C -- No --> A
    C -- Yes --> D[Enter Position LONG/SHORT]

    D --> E{TP1 Hit?}
    E -- Yes --> F[Close 25% + tighten trailing]
    E -- No --> G{TP2 Hit?}

    G -- Yes --> H[Close 25% + tighten trailing]
    G -- No --> I{TP3 Hit?}

    I -- Yes --> J[Close 50% → Exit]
    I -- No --> K{StopLoss / TrailingStop / Reverse / TimeLimit}
    K -- Yes --> J[Close All → Exit]
    K -- No --> D
