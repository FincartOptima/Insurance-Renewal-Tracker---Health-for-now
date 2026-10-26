import hmac
import os
import secrets
import tempfile
import time
from datetime import timedelta
from urllib.parse import urlparse

from dotenv import load_dotenv

load_dotenv()

from flask import Flask, flash, jsonify, redirect, render_template, request, session, url_for, send_file  # noqa: E402
from werkzeug.middleware.proxy_fix import ProxyFix  # noqa: E402

import db  # noqa: E402
import ingest  # noqa: E402
import queries  # noqa: E402
import exports  # noqa: E402

app = Flask(__name__)

# Sessions are signed with this key, so a guessable one would let anyone forge a
# login. Placeholder values fall back to a random key (sessions then reset on restart).
_PLACEHOLDER_KEYS = {"", "change-me", "health-ops-renewal-tracker"}
_secret_key = os.environ.get("SECRET_KEY", "")
app.secret_key = secrets.token_hex(32) if _secret_key in _PLACEHOLDER_KEYS else _secret_key

app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
)
if os.environ.get("RENDER"):
    # Behind Render's proxy: use the real client address and scheme.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

ALLOWED = {".xls", ".xlsx"}

LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 15 * 60
_failed_logins = {}  # client address -> timestamps of recent failed sign-ins


def _configured_credentials():
    return os.environ.get("APP_USERNAME", ""), os.environ.get("APP_PASSWORD", "")


def _auth_token():
    """Proof of a valid sign-in, tied to the current credentials so that changing
    APP_PASSWORD signs everyone out. None when sign-in isn't configured."""
    username, password = _configured_credentials()
    if not username or not password:
        return None
    return hmac.new(app.secret_key.encode(), f"{username}\0{password}".encode(), "sha256").hexdigest()


def _is_signed_in():
    token = _auth_token()
    return bool(token) and hmac.compare_digest(str(session.get("auth", "")), token)


def _credentials_match(username, password):
    expected_user, expected_password = _configured_credentials()
    if not expected_user or not expected_password:
        return False
    user_ok = hmac.compare_digest(username.casefold().encode(), expected_user.casefold().encode())
    password_ok = hmac.compare_digest(password.encode(), expected_password.encode())
    return user_ok and password_ok


def _recent_failures(address):
    cutoff = time.time() - LOGIN_WINDOW_SECONDS
    recent = [t for t in _failed_logins.get(address, []) if t > cutoff]
    if recent:
        _failed_logins[address] = recent
    else:
        _failed_logins.pop(address, None)
    return recent


def _safe_next(target):
    """Only follow same-site paths after sign-in, never an external address."""
    if target and target.startswith("/") and not target.startswith("//") and "\\" not in target:
        parsed = urlparse(target)
        if not parsed.scheme and not parsed.netloc and parsed.path not in ("/login", "/logout"):
            return target
    return url_for("overview")


@app.before_request
def require_login():
    if app.config.get("LOGIN_DISABLED") or request.endpoint in ("login", "static"):
        return None
    if _is_signed_in():
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "Please sign in again.", "login": url_for("login")}), 401
    if request.method == "GET":
        return redirect(url_for("login", next=request.full_path.rstrip("?")))
    return redirect(url_for("login"))


@app.after_request
def no_store(response):
    # Pages and API responses carry client data; keep them out of shared caches.
    if request.endpoint != "static":
        response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.route("/login", methods=["GET", "POST"])
def login():
    next_url = _safe_next(request.values.get("next"))
    configured = _auth_token() is not None
    if request.method == "GET":
        if _is_signed_in():
            return redirect(next_url)
        return render_template("login.html", next_url=next_url, configured=configured)

    address = request.remote_addr or "unknown"
    if len(_recent_failures(address)) >= LOGIN_MAX_FAILURES:
        return render_template(
            "login.html", next_url=next_url, configured=configured,
            error="Too many incorrect attempts. Please wait a few minutes and try again.",
        ), 429
    if _credentials_match(request.form.get("username", "").strip(), request.form.get("password", "")):
        _failed_logins.pop(address, None)
        session.clear()
        session["auth"] = _auth_token()
        session.permanent = True
        return redirect(next_url)

    if len(_failed_logins) > 5000:
        _failed_logins.clear()
    _failed_logins.setdefault(address, []).append(time.time())
    return render_template(
        "login.html", next_url=next_url, configured=configured, error="Incorrect ID or password.",
    ), 401


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/", methods=["GET"])
def overview():
    db.init_db()
    conn = db.connect()
    try:
        total = db.count_renewals(conn)
    finally:
        conn.close()
    return render_template("overview.html", total=total)


@app.route("/tracker", methods=["GET"])
def tracker():
    db.init_db()
    conn = db.connect()
    try:
        total = db.count_renewals(conn)
    finally:
        conn.close()
    return render_template("dashboard.html", total=total)


def _render_upload_page(result=None, employee_result=None, leads_result=None):
    conn = db.connect()
    try:
        total = db.count_renewals(conn)
        last = db.get_meta(conn, "last_upload")
        last_employee = db.get_meta(conn, "last_employee_upload")
    finally:
        conn.close()
    return render_template(
        "upload.html", total=total, last_upload=last, last_employee=last_employee,
        result=result, employee_result=employee_result, leads_result=leads_result,
    )


def _save_and_run(file_storage, run):
    ext = os.path.splitext(file_storage.filename)[1].lower()
    if ext not in ALLOWED:
        raise ingest.IngestError(f"'{file_storage.filename}' is not an Excel file. Upload .xls or .xlsx.")
    fd, tmp_path = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    file_storage.save(tmp_path)
    try:
        return run(tmp_path, file_storage.filename)
    finally:
        os.remove(tmp_path)


@app.route("/upload", methods=["GET", "POST"])
def upload():
    db.init_db()

    if request.method == "GET":
        return _render_upload_page()

    insurance_file = request.files.get("insurance")
    employee_file = request.files.get("employee_ref")
    leads_file = request.files.get("leads")
    if not any(f and f.filename for f in (insurance_file, employee_file, leads_file)):
        flash("Choose at least one file to upload.", "error")
        return redirect(url_for("upload"))

    employee_result = None
    try:
        # Employee reference first, so an insurance file uploaded in the same
        # submission resolves teams against the freshly uploaded mapping.
        if employee_file and employee_file.filename:
            employee_result = _save_and_run(employee_file, ingest.ingest_employee_file)

        result = None
        if insurance_file and insurance_file.filename:
            result = _save_and_run(insurance_file, ingest.ingest_policy_file)

        # Leads/RM backfill last - it only fills in RM where the policy
        # import above left one blank, so it should see today's import first.
        leads_result = None
        if leads_file and leads_file.filename:
            leads_result = _save_and_run(leads_file, ingest.backfill_rm_from_leads)
    except ingest.IngestError as exc:
        flash(str(exc), "error")
        return redirect(url_for("upload"))

    return _render_upload_page(result=result, employee_result=employee_result, leads_result=leads_result)


def _filtered_renewals():
    conn = db.connect()
    try:
        return queries.build(
            conn, bucket=request.args.get("bucket", "next7"),
            search=request.args.get("q", ""), insurance_type=request.args.get("type", "all"),
            team=request.args.get("team", "all"), rm=request.args.get("rm", "all"),
            status=request.args.get("status", "all"), month=request.args.get("month", "all"),
            start=request.args.get("start"), end=request.args.get("end"),
        )
    finally:
        conn.close()


@app.route("/api/overview")
def api_overview():
    conn = db.connect()
    try:
        return jsonify(queries.overview(conn))
    finally:
        conn.close()


@app.route("/api/renewals")
def api_renewals():
    try:
        return jsonify(_filtered_renewals())
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/renewals/export")
def export_renewals():
    try:
        data = _filtered_renewals()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    response = send_file(
        exports.workbook(data), as_attachment=True,
        download_name=f"renewals-{data['bucket']}-{data['as_of']}.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/renewals/<path:policy_no>", methods=["PATCH"])
def update_renewal(policy_no):
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Expected an object."}), 400
    conn = db.connect()
    try:
        result = (queries.update_fields(conn, policy_no, data["fields"]) if "fields" in data
                  else queries.update_field(conn, policy_no, data.get("field"), data.get("value")))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    finally:
        conn.close()
    return jsonify(result)


@app.route("/reset", methods=["POST"])
def reset():
    db.init_db()
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM renewals")
        conn.commit()
    finally:
        conn.close()
    flash("All stored renewal data cleared.", "ok")
    return redirect(url_for("upload"))


if __name__ == "__main__":
    db.init_db()
    app.run(debug=True, port=5003)
