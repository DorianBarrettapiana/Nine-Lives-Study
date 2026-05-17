# PhDStudyLab

PhDStudyLab is a lightweight web application designed to **gamify focused work sessions** in order to improve motivation, consistency, and productivity over long periods of study or research.

![PhD Study Lab Home Page](docs/home_page.png "Home Page")

## ✨ Features (planned)

- Work session tracking (Pomodoro-style or free sessions)
- Gamification system (XP, levels, rewards)
- Progress visualization (daily / weekly stats)
- Achievements & milestones
- Multi-user support (local first, web-ready later)
- Persistent storage with SQLite
- Clean and extensible architecture

## 🚀 Getting Started

### Backend

#### Requirements

- Python ≥ 3.10
- FastAPI
- Uvicorn
- SQLAlchemy
- Pydantic

#### Create a virtual environment if needed (recommended)

```bash
cd backend
conda create -n env_name python=3.12
pip install fastapi uvicorn sqlalchemy
```

Run the backend
```bash
uvicorn app.main:app --reload
```

### Frontend

Open frontend/index.html in your browser.

## 🔁 Example Workflow

1. User starts a session
2. Data sent to backend
3. Stored in SQLite
4. XP computed
5. UI updated

## 🔮 Future Improvements

- Authentication system
- Public deployment
- Real-time updates
- Advanced analytics
- Mobile UI
