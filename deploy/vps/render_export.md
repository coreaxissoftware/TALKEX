# Getting TalkEx's data off Render onto the VPS

Render's **free tier has no SSH/shell**, so we can't `scp` the persistent disk
directly. Plan: add a **temporary, superadmin-only** export endpoint that streams
the whole data dir (SQLite DB + uploads + VAPID keys) as one `.tar.gz`, deploy it,
pull it onto the VPS, extract into `<DATA_DIR>`, then **remove the endpoint**.

> Migrating the *whole* `DATA_DIR` (not just the .db) matters: it also carries the
> uploaded files and the VAPID keypair, so existing web-push subscriptions keep
> working and no attachment 404s.

## 1. Add the temporary endpoint (branch, deploy to Render)

Add to `backend/main.py` (adapt to how `DATA_DIR`, auth, and the superadmin check
are actually named in the code — confirm before finalising):

```python
# --- TEMPORARY data export for VPS migration. REMOVE after the pull. ---
import io, os, tarfile
from fastapi.responses import StreamingResponse

@app.get("/admin/_export_data")
def _export_data(user=Depends(get_current_user)):
    # Superadmin only — reuse the app's existing check.
    if not user or user.get("username", "").lower() != os.environ.get("SUPERADMIN_USERNAME", "").lower():
        raise HTTPException(403, "forbidden")
    data_dir = os.environ.get("DATA_DIR", "/data")

    def stream():
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            tar.add(data_dir, arcname=".")
        buf.seek(0)
        yield from buf

    return StreamingResponse(
        stream(), media_type="application/gzip",
        headers={"Content-Disposition": 'attachment; filename="talkex-data.tar.gz"'},
    )
# --- end temporary export ---
```

Notes:
- For a large uploads dir, streaming a single in-memory tar can be heavy on the
  free tier's RAM. If it's big, tar to a temp file on disk first and
  `FileResponse` it, or export in parts (db separately from uploads/).
- Consider putting the app in a quiet moment / brief maintenance so the SQLite
  file is consistent (SQLite copy while writing is usually fine with WAL, but a
  quiet window is safest).

## 2. Pull it onto the VPS

Get a valid superadmin auth token (log in as the superadmin in the web app, copy
the bearer token), then on the VPS:

```bash
curl -f -H "Authorization: Bearer <SUPERADMIN_TOKEN>" \
  https://talkex-backend.onrender.com/admin/_export_data \
  -o /tmp/talkex-data.tar.gz

sudo mkdir -p <DATA_DIR>
sudo tar -C <DATA_DIR> -xzf /tmp/talkex-data.tar.gz
sudo chown -R <SERVICE_USER>:<SERVICE_USER> <DATA_DIR>
ls -la <DATA_DIR>            # verify the .db + uploads are present
```

## 3. Remove the endpoint

Revert the temporary code and redeploy Render (or just delete the branch/commit).
Verify `GET /admin/_export_data` now 404s.

## 4. Point the VPS backend at the migrated data

`<ENV_FILE>` already has `DATA_DIR=<DATA_DIR>`. Start the service and confirm the
migrated data is served:

```bash
sudo systemctl enable --now talkex-backend
curl -f http://127.0.0.1:<BACKEND_PORT>/health
# then, once DNS+TLS are up, log in as an existing user to confirm data is intact.
```

## Alternative (if you have any other Render access)

If you later attach a paid Render shell or a one-off job, `tar czf - -C /data . `
piped over SSH is simpler. But the endpoint above needs no paid features.
