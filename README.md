# NYX99

> A sophisticated humanity simulator built with Node.js

## 📖 Overview

NYX99 is an advanced simulation system designed to model and simulate human behavior, social interactions, and population dynamics. The project provides a comprehensive framework for creating, managing, and analyzing simulated human societies with configurable parameters and real-time monitoring. It's a project I'm vibe coding long term, like my own digital model train set, or terrarium.

## ✨ Features

- **Agent-Based Simulation**: Model individual humans with unique characteristics and behaviors
- **Real-Time Monitoring**: Track simulation metrics and population dynamics through an interactive UI
- **Scalable Architecture**: Worker-based design for handling large-scale simulations
- **Data Persistence**: Database integration for storing simulation states and historical data
- **Configurable Environment**: Flexible configuration system via environment variables
- **Logging System**: Comprehensive logging for debugging and analysis

## 🏗️ Architecture

```
NYX99/
├── engine/          # Core simulation engine
├── services/        # Business logic and service layer
├── workers/         # Background processing workers
├── ui/              # User interface components
├── data/            # Data storage and models
├── Docs/            # Documentation
├── index.js         # Main application entry point
├── dbService.js     # Database service layer
├── logger.js        # Logging utilities
└── config.env       # Configuration file
```

## 🚀 Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Database (MongoDB/PostgreSQL/MySQL - specify your choice)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/mraml/NYX99.git
cd NYX99
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp config.env .env
# Edit .env with your configuration
```

4. Start the simulation:
```bash
npm start
```

## ⚙️ Configuration

Edit the `config.env` file to customize simulation parameters:

```env
# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=nyx99

# Simulation Parameters
POPULATION_SIZE=1000
SIMULATION_SPEED=1.0
MAX_AGE=100

# Worker Configuration
WORKER_THREADS=4

# Logging
LOG_LEVEL=info
```

## 🎮 Usage

### Starting a Simulation

```javascript
const NYX99 = require('./index');

const simulation = new NYX99({
  populationSize: 1000,
  simulationSpeed: 1.0,
  enableUI: true
});

simulation.start();
```

### Monitoring Simulation State

Access the web UI at `http://localhost:3000` (or your configured port) to:
- View real-time population statistics
- Monitor individual agents
- Control simulation parameters
- Export simulation data

### API Endpoints

```
GET  /api/status          - Get simulation status
POST /api/start           - Start simulation
POST /api/stop            - Stop simulation
GET  /api/agents          - List all agents
GET  /api/agents/:id      - Get specific agent details
POST /api/config          - Update configuration
GET  /api/metrics         - Get simulation metrics
```

## 📊 Simulation Components

### Agents (Humans)
Each simulated human has:
- Demographic attributes (age, gender, etc.)
- Personality traits
- Social connections
- Health status
- Economic status
- Decision-making capabilities

### Environment
The simulation environment includes:
- Resource distribution
- Social structures
- Economic systems
- Environmental conditions

### Events
Dynamic events that affect the simulation:
- Natural events
- Social movements
- Economic changes
- Health crises

## 🔧 Development

### Project Structure

- **engine/**: Core simulation logic and algorithms
- **services/**: Service layer for business logic
- **workers/**: Background workers for parallel processing
- **ui/**: Frontend interface for visualization
- **data/**: Data models and database schemas

### Running Tests

```bash
npm test
```

### Building for Production

```bash
npm run build
```

## 📚 Documentation

For detailed documentation, see the [Docs](./Docs) directory:
- [Architecture Guide](./Docs/architecture.md)
- [API Reference](./Docs/api.md)
- [Configuration Guide](./Docs/configuration.md)
- [Development Guide](./Docs/development.md)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## 👥 Authors

- **mraml** - *Initial work* - [GitHub](https://github.com/mraml)

## 🙏 Acknowledgments

- Inspired by the need to populate the world with simulated humans to lower your odds of being in base reality.

---

**NYX99** - Simulating humanity, one agent at a time.
