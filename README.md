# Detector Service

The `detector` service is a core component of the `barfin-network` ecosystem. It is designed to support algorithmic strategies for financial signal detection, backtesting, and alert generation. Built using **NestJS**, it emphasizes modularity, testability, and ease of integration with other services.

---

## Features

* **Strategy Framework**: Supports pluggable strategies like "follow-trend" and "test".
* **Alert System**: Generates alerts based on strategy signals.
* **Backtesting Tools**: Includes a `history` module for running and evaluating strategies over historical data.
* **Plugin Driver**: Enables dynamic interaction with strategy modules.
* **Provider Integration**: Interacts with the `provider` service for real-time or historical data.
* **Validation Utilities**: Includes shared logic for validating strategy inputs.

---

## File Structure

The project is organized into clear NestJS modules, supporting flexibility and scalability.

### Root Files

* **`.dockerignore`**: Files ignored during Docker build.
* **`Dockerfile`**: Builds the container image.
* **`tsconfig.app.json`**: TypeScript app config.

### `src` Directory

#### 1. **App Module**

* **Files**:

  * `app.controller.ts`: Root API endpoints.
  * `app.service.ts`: Basic service logic.
  * `main.ts`: App entry point.

#### 2. **Alert Module**

* **Files**:

  * `alert.controller.ts`: Routes for alert handling.
  * `alert.service.ts`: Business logic for alert generation.
  * `alert.module.ts`: Alert-specific NestJS module.

#### 3. **Detector Module**

* **Purpose**: Core logic for strategy execution.
* **Files**:

  * `detector.controller.ts`: Strategy execution API.
  * `detector.service.ts`: Runs detection logic.
  * `sample/`: Example strategies:

    * `follow-trend.service.ts`: Example trend-following logic.
    * `test.service.ts`: Sample testing logic.
    * Configs in `.config.ts` files.
    * `template.service.ts`: Template for new strategies.

#### 4. **Common Module**

* **Files**:

  * `common.service.ts`: Shared utilities.
  * `validation.util.ts`: Input validation helpers.

#### 5. **History Module**

* **Files**:

  * `index.ts`: History test runner.
  * `tester-transport.ts`: Handles test transport interfaces.

#### 6. **Plugin Driver Module**

* **Files**:

  * `plugin-driver.module.ts`: Plugin system wrapper.
  * `plugin-driver.service.ts`: Loads and interacts with strategies.

#### 7. **Provider Module**

* **Files**:

  * `provider.controller.ts`: For data access from provider services.
  * `provider.service.ts`: Logic to query price data and metadata.

---

## Deployment Instructions

### Prerequisites

* **Docker** and **Docker Compose**
* `.env` file with required environment variables

### Steps

1. **Build Docker Image**:

   ```bash
   docker build -t detector-service:latest -f Dockerfile .
   ```

2. **Run the Service**:

   ```bash
   docker run -d -p 3000:3000 --env-file .env detector-service:latest
   ```

---

## Key Technologies

* **NestJS**: Scalable Node.js backend framework
* **TypeScript**: Strictly typed JavaScript
* **Docker**: Containerization
* **Custom Strategy Framework**: Strategy plugins for backtests and real-time detection

---

## License

This project is licensed under the [Apache License 2.0](LICENSE) with additional restrictions.

### Key Terms:

1. **Attribution**: You must give proper credit to "Barfin Network Limited".
2. **Non-Commercial Use**: Commercial usage requires written permission.
3. **Display Requirements**:

   * Mention "Barfin Network Limited".
   * Show the official logo.
   * Link to [https://barfin.network/](https://barfin.network/)

Contact us via [https://barfin.network/](https://barfin.network/) for permissions or questions.