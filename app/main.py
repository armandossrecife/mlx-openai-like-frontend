import os
import json
import requests
from flask import Flask, render_template, request, redirect, url_for, session, flash, Response, stream_with_context, jsonify
from datetime import datetime

def create_app():
    app = Flask(__name__)
    app.secret_key = os.getenv("FLASK_SECRET_KEY", "CHANGE_ME_FRONTEND_SECRET")

    BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")

    def token():
        return session.get("access_token")
    
    def get_user_email():
        return session.get("user_email")

    def auth_headers():
        t = token()
        return {"Authorization": f"Bearer {t}"} if t else {}

    def require_login():
        if not token():
            return redirect(url_for("login"))
        return None

    @app.get("/")
    def root():
        if token():
            return redirect(url_for("dashboard"))
        return redirect(url_for("login"))

    # -------- HEALTH (usado pelo chat.js) --------
    @app.get("/health")
    def health():
        try:
            r = requests.get(f"{BACKEND_URL}/health", timeout=30)
            if r.status_code == 200:
                return {"status": "healthy"}
        except Exception:
            pass
        return {"status": "unhealthy"}, 503

    # -------- AUTH PAGES --------
    @app.get("/register")
    def register_page():
        return render_template("register.html")

    @app.post("/register")
    def register():
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "").strip()

        r = requests.post(f"{BACKEND_URL}/auth/register", json={"email": email, "password": password}, timeout=10)
        if r.status_code == 200:
            flash("Cadastro realizado. Faça login.", "success")
            return redirect(url_for("login"))
        try:
            msg = r.json().get("detail", "Erro ao cadastrar")
        except Exception:
            msg = "Erro ao cadastrar"
        flash(msg, "danger")
        return redirect(url_for("register_page"))

    @app.get("/login")
    def login():
        return render_template("login.html")

    @app.post("/login")
    def do_login():
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "").strip()

        r = requests.post(f"{BACKEND_URL}/auth/login", json={"email": email, "password": password}, timeout=10)
        if r.status_code == 200:
            session["access_token"] = r.json()["access_token"]
            session["user_email"] = email
            return redirect(url_for("dashboard"))
        try:
            msg = r.json().get("detail", "Login inválido")
        except Exception:
            msg = "Login inválido"
        flash(msg, "danger")
        return redirect(url_for("login"))

    @app.get("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # -------- DASHBOARD --------
    @app.get("/dashboard")
    def dashboard():
        red = require_login()
        if red:
            return red

        r = requests.get(f"{BACKEND_URL}/chats", headers=auth_headers(), timeout=10)
        chats = r.json() if r.status_code == 200 else []
        return render_template("dashboard.html", chats=chats, email=get_user_email())

    @app.post("/chats/new")
    def create_chat():
        red = require_login()
        if red:
            return red

        title = request.form.get("title", "Novo Chat").strip()
        r = requests.post(f"{BACKEND_URL}/chats", headers=auth_headers(), json={"title": title}, timeout=10)
        if r.status_code == 200:
            chat_id = r.json()["id"]
            return redirect(url_for("chat_page", chat_id=chat_id))
        flash("Erro ao criar chat", "danger")
        return redirect(url_for("dashboard"), is_active=True)

    # -------- CHAT PAGE --------
    @app.get("/chat/<int:chat_id>")
    def chat_page(chat_id: int):
        red = require_login()
        if red:
            return red

        mr = requests.get(f"{BACKEND_URL}/models", timeout=10)
        models = [m["name"] for m in (mr.json().get("models", []) if mr.status_code == 200 else [])]
        return render_template(
            "chat.html",
            chat_id=chat_id,
            models=models or ["Qwen3-4B-Instruct-2507-4bit"],
            is_active=True,
        )

    # -------- API: HISTORY --------
    @app.get("/api/history/<int:chat_id>")
    def history(chat_id: int):
        red = require_login()
        if red:
            return ("Unauthorized", 401)

        r = requests.get(f"{BACKEND_URL}/chats/{chat_id}/messages", headers=auth_headers(), timeout=15)
        return (r.text, r.status_code, {"Content-Type": "application/json"})


    @app.get("/chat/<int:chat_id>/history")
    def chat_history_page(chat_id: int):
        red = require_login()
        if red:
            return red

        chat = None
        cr = requests.get(f"{BACKEND_URL}/chats", headers=auth_headers(), timeout=10)
        if cr.status_code == 200:
            for c in (cr.json() or []):
                if int(c.get("id")) == int(chat_id):
                    chat = c
                    break
        if not chat:
            flash("Chat não encontrado (ou não pertence ao usuário).", "danger")
            return redirect(url_for("dashboard"))

        mr = requests.get(
            f"{BACKEND_URL}/chats/{chat_id}/messages",
            headers=auth_headers(),
            timeout=15,
        )

        if mr.status_code != 200:
            flash("Não foi possível carregar o histórico do chat.", "danger")
            return redirect(url_for("dashboard"))

        messages = mr.json() or []

        def fmt_dt(iso_str: str) -> str:
            try:
                dt = datetime.fromisoformat(iso_str)
                return dt.strftime("%d/%m/%Y %H:%M")
            except Exception:
                return iso_str

        for m in messages:
            m["created_at"] = fmt_dt(m.get("created_at", ""))

        chat_view = {
            "id": chat.get("id"),
            "title": chat.get("title"),
            "created_at": fmt_dt(chat.get("created_at", "")),
            "is_active": True,
        }

        return render_template(
            "chat_history.html",
            title="Histórico do Chat",
            email=get_user_email(),
            chat=chat_view,
            messages=messages,
        )

    # -------- API: GENERATE (NO STREAM) --------
    @app.post("/api/generate")
    def api_generate():
        red = require_login()
        if red:
            return jsonify({"detail": "Unauthorized"}), 401

        data = request.get_json(force=True) or {}
        
        # Monta o payload forçando stream=False
        payload = {
            "model": data.get("model"),
            "prompt": data.get("prompt"),
            "resposta": "string", 
            "chat_id": int(data.get("chat_id")),
            "stream": False,  # IMPORTANTE: Força modo sem stream
            "options": None
        }

        try:
            # Chama o backend e aguarda a resposta completa
            # Timeout aumentado para 60s pois geração completa pode demorar
            r = requests.post(
                f"{BACKEND_URL}/generate",
                json=payload,
                headers=auth_headers(),
                timeout=60 
            )
                    
            if r.status_code == 200:
                # Retorna o JSON do backend (GenerateWithChat) diretamente para o frontend JS
                return jsonify(r.json())
            else:
                try:
                    err_det = r.json()
                except:
                    err_det = {"detail": r.text}
                return jsonify(err_det), r.status_code

        except Exception as e:
            return jsonify({"detail": str(e)}), 500

    # -------- API: STREAM (proxy SSE com JWT) --------
    @app.post("/api/stream")
    def stream():
        red = require_login()
        if red:
            return ("Unauthorized", 401)

        data = request.get_json(force=True) or {}
        payload = {
            "model": data["model"],
            "prompt": data["prompt"],
            "chat_id": int(data["chat_id"]),
            "stream": True,
        }

        def generate():
            with requests.post(
                f"{BACKEND_URL}/generate",
                json=payload,
                stream=True,
                headers={**auth_headers(), "Accept": "text/event-stream"},
                timeout=300,
            ) as r:
                if r.status_code != 200:
                    yield f"data: {json.dumps({'type':'error','error':f'Backend error {r.status_code}: {r.text}'})}\n\n"
                    return

                for line in r.iter_lines(decode_unicode=True):
                    if line is None:
                        continue
                    if line == "":
                        yield "\n"
                        continue
                    yield line + "\n"

        return Response(
            stream_with_context(generate()),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
        )

    return app

app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True, threaded=True)