import os, time, urllib.request, logging, json, secrets, ipaddress, threading
from typing import Optional
from flask import Flask, jsonify, request, abort, render_template, send_from_directory
import docker
from urllib import parse as _urlparse
from urllib.error import HTTPError

logging.basicConfig(level=logging.INFO)
app = Flask(__name__)

SETTINGS_PATH = os.getenv("SETTINGS_PATH", "/data/settings.json")

def _truthy(v):
  return str(v).lower() in ("1", "true", "yes", "on")

def _load_settings_from_disk():
  try:
    if not os.path.isfile(SETTINGS_PATH):
      return None
    with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
      return json.load(f)
  except Exception:
    return None

def _save_settings_to_disk(payload: dict):
  try:
    import tempfile, shutil
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    d = json.dumps(payload, ensure_ascii=False, indent=2)
    dir_ = os.path.dirname(SETTINGS_PATH) or "."
    with tempfile.NamedTemporaryFile("w", delete=False, dir=dir_, encoding="utf-8") as tmp:
      tmp.write(d); tmp_path = tmp.name
    shutil.move(tmp_path, SETTINGS_PATH)
    return True
  except Exception:
    return False

GUI_ENABLED = os.getenv("GUI_ENABLED", "true").lower() in ("1", "true", "yes", "on")

AUTH_ENABLED = False
CURRENT_API_KEY = ""
ALLOWED_CIDRS = ["0.0.0.0/0"]

ENV_AUTH = os.getenv("AUTH_ENABLED") or os.getenv("DOCKER_MONITOR_AUTH_ENABLED")
if ENV_AUTH is not None:
  AUTH_ENABLED = _truthy(ENV_AUTH)

ENV_KEY = os.getenv("API_KEY") or os.getenv("DOCKER_MONITOR_API_KEY")
if ENV_KEY:
  CURRENT_API_KEY = str(ENV_KEY)

ALLOWED_IPS_ENV = os.getenv("ALLOWED_IPS")
if ALLOWED_IPS_ENV:
  ALLOWED_CIDRS = [ip.strip() for ip in ALLOWED_IPS_ENV.split(",") if ip.strip()]

_disk = _load_settings_from_disk()
if isinstance(_disk, dict):
  AUTH_ENABLED = bool(_disk.get("auth_enabled", AUTH_ENABLED))
  CURRENT_API_KEY = str(_disk.get("api_key", CURRENT_API_KEY) or "")
  _cidrs = _disk.get("allowed_cidrs")
  if isinstance(_cidrs, list):
    parsed = [str(c).strip() for c in _cidrs if str(c).strip()]
    if parsed:
      ALLOWED_CIDRS = parsed

def _check_auth():
  if not AUTH_ENABLED:
    return True
  provided = request.args.get('key') or ''
  return bool(CURRENT_API_KEY) and (provided == CURRENT_API_KEY)

def _is_ip_allowed(addr: str) -> bool:
  try:
    ip = ipaddress.ip_address(addr)
  except Exception:
    return False
  for net_s in ALLOWED_CIDRS:
    try:
      net = ipaddress.ip_network(net_s, strict=False)
      if ip in net:
        return True
    except Exception:
      continue
  return False

client = docker.DockerClient(base_url='unix://var/run/docker.sock', version='auto', timeout=10)

try:
  SELF_CONTAINER_ID = os.getenv("HOSTNAME")
  _self = client.containers.get(SELF_CONTAINER_ID) if SELF_CONTAINER_ID else None
  SELF_CONTAINER_NAME = _self.name if _self else None
except Exception:
  SELF_CONTAINER_ID = None
  SELF_CONTAINER_NAME = None

_pull_cache = {}
CACHE_TTL = 3600

try:
  _INFO = client.info()
  _LOCAL_OS = str(_INFO.get('OSType') or _INFO.get('OperatingSystem') or 'linux').lower()
  _LOCAL_ARCH = str(_INFO.get('Architecture') or 'amd64').lower()
except Exception:
  _LOCAL_OS = 'linux'
  _LOCAL_ARCH = 'amd64'

_ARCH_MAP = {'x86_64': 'amd64','aarch64': 'arm64','arm64/v8': 'arm64','arm64v8': 'arm64','armv7l': 'arm','armv7': 'arm','armv6l': 'arm'}
_LOCAL_ARCH = _ARCH_MAP.get(_LOCAL_ARCH, _LOCAL_ARCH)

def _compute_unused_images():
  try:
    dangling_imgs = client.images.list(all=True, filters={"dangling": True})
    items = []
    for img in dangling_imgs:
      try:
        items.append({'id': img.id, 'tags': img.tags or []})
      except Exception:
        continue
    return len(items), items
  except Exception as e:
    app.logger.info('unused(dangling) compute failed: %s', e)
    return 0, []

@app.get('/images/unused')
def images_unused():
  if not _check_auth():
    return jsonify({'error': 'unauthorized'}), 401
  count, items = _compute_unused_images()
  return jsonify({'count': count, 'items': items})

@app.post('/images/prune')
def images_prune():
  if not _check_auth():
    return jsonify({'error': 'unauthorized'}), 401
  try:
    result = client.images.prune({'dangling': True})
    return jsonify(result or {})
  except Exception as e:
    return jsonify({'error': str(e)}), 500

def get_remote_digest(image: str) -> Optional[str]:
  ACCEPTS = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ]
  def _split_repo_tag(ref: str):
    if ":" in ref and "/" in ref.split(":")[0]: repo, tag = ref.rsplit(":", 1)
    elif ":" in ref and "/" not in ref: repo, tag = ref.split(":", 1)
    else: repo, tag = ref, "latest"
    return repo, tag
  def _resolve_registry_and_path(repo: str):
    if repo.startswith("lscr.io/"): return "lscr.io", repo[len("lscr.io/"):]
    if "/" not in repo: return "registry-1.docker.io", f"library/{repo}"
    parts = repo.split("/", 1)
    if "." in parts[0] or ":" in parts[0]: return parts[0], parts[1]
    return "registry-1.docker.io", repo
  def _parse_www_authenticate(header_val: str):
    scheme, _, params = header_val.partition(" ")
    if scheme.lower() != "bearer": return None
    d = {}
    for part in params.split(","):
      if "=" in part:
        k, v = part.split("=", 1)
        d[k.strip()] = v.strip().strip('"')
    return d
  def _head_or_get(url: str, token: Optional[str]):
    for acc in ACCEPTS:
      headers = {"Accept": acc}
      if token: headers["Authorization"] = f"Bearer {token}"
      try:
        req = urllib.request.Request(url, headers=headers); req.get_method = lambda: "HEAD"
        with urllib.request.urlopen(req, timeout=12) as resp:
          d = resp.headers.get("Docker-Content-Digest")
          if d: return d, None
      except HTTPError as he:
        if he.code in (401, 404): return None, he.code
      except Exception:
        pass
      try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=12) as resp:
          d = resp.headers.get("Docker-Content-Digest")
          if d: return d, None
      except HTTPError as he:
        if he.code in (401, 404): return None, he.code
      except Exception:
        pass
    return None, None
  def _fetch_with_optional_auth(url: str, registry_hint: str):
    try:
      d, code = _head_or_get(url, None)
      if d or (code and code != 401): return d, code
    except HTTPError as e:
      if e.code != 401: return None, e.code
    except Exception:
      return None, None
    try:
      req = urllib.request.Request(url, headers={"Accept": ACCEPTS[0]})
      with urllib.request.urlopen(req, timeout=12) as resp:
        return resp.headers.get("Docker-Content-Digest"), None
    except HTTPError as e:
      if e.code != 401: return None, e.code
      www = e.headers.get("WWW-Authenticate")
      if not www: return None, 401
      info = _parse_www_authenticate(www)
      if not info or not info.get("realm"): return None, 401
      realm = info["realm"]; qp = {}
      if info.get("service"): qp["service"] = info["service"]
      if info.get("scope"): qp["scope"] = info["scope"]
      token_url = realm + ("?" + _urlparse.urlencode(qp) if qp else "")
      try:
        with urllib.request.urlopen(token_url, timeout=12) as tr:
          payload = json.loads(tr.read().decode("utf-8", errors="ignore") or "{}")
          token = payload.get("token") or payload.get("access_token")
          if not token: return None, 401
      except Exception:
        return None, 401
      return _head_or_get(url, token)
    except Exception:
      return None, None
  try:
    repo, tag = _split_repo_tag(image)
    registry, repo_path = _resolve_registry_and_path(repo)
    url = f"https://{registry}/v2/{repo_path}/manifests/{tag}"
    digest, code = _fetch_with_optional_auth(url, registry)
    if digest: return digest
    if (not digest) and code == 404 and registry == "lscr.io" and repo_path.startswith("linuxserver/"):
      gh_url = f"https://ghcr.io/v2/{repo_path}/manifests/{tag}"
      gd, _ = _fetch_with_optional_auth(gh_url, "ghcr.io")
      if gd: return gd
    return None
  except Exception:
    return None

def fetch_remote_digest_cached(image_ref: str, *, force: bool = False, now_ts: Optional[float] = None):
  global _pull_cache
  now_ts = now_ts or time.time()
  if (not force) and image_ref in _pull_cache and (now_ts - _pull_cache[image_ref]["ts"] < CACHE_TTL):
    return _pull_cache[image_ref]["digest"]
  digest = get_remote_digest(image_ref)
  _pull_cache[image_ref] = {"digest": digest, "ts": now_ts}
  return digest

@app.before_request
def limit_remote_addr():
  if not _is_ip_allowed(request.remote_addr or ""):
    abort(403)

@app.get('/settings')
def get_settings():
  return jsonify({
    'auth_enabled': AUTH_ENABLED,
    'api_key': CURRENT_API_KEY if not AUTH_ENABLED else '********',
    'allowed_cidrs': ALLOWED_CIDRS,
  })

@app.post('/settings')
def post_settings():
  global AUTH_ENABLED, CURRENT_API_KEY, ALLOWED_CIDRS
  data = request.get_json(silent=True) or {}
  AUTH_ENABLED = bool(data.get('auth_enabled'))
  gen_flag = bool(data.get('generate_api_key'))
  posted_key = data.get('api_key')
  if gen_flag or (AUTH_ENABLED and not posted_key):
    CURRENT_API_KEY = secrets.token_urlsafe(24)
  elif posted_key is not None:
    CURRENT_API_KEY = str(posted_key)
  cidrs = data.get('allowed_cidrs')
  if isinstance(cidrs, list):
    parsed = [str(c).strip() for c in cidrs if str(c).strip()]
  elif isinstance(cidrs, str):
    parsed = [c.strip() for c in cidrs.replace(',', '\n').split('\n') if c.strip()]
  else:
    parsed = None
  if parsed is not None:
    ALLOWED_CIDRS = parsed or ["0.0.0.0/0"]
  _save_settings_to_disk({"auth_enabled": AUTH_ENABLED, "api_key": CURRENT_API_KEY, "allowed_cidrs": ALLOWED_CIDRS})
  return jsonify({'ok': True, 'auth_enabled': AUTH_ENABLED, 'api_key': CURRENT_API_KEY, 'allowed_cidrs': ALLOWED_CIDRS})

@app.get("/health")
def health():
  if not _check_auth():
    return jsonify({"ok": False, "error": "unauthorized"}), 401
  try:
    names = [c.name for c in client.containers.list(all=True)]
  except Exception as e:
    return jsonify({"ok": False, "error": str(e)}), 500
  return jsonify({"ok": True, "containers": names})

def _digest_only(value: Optional[str]):
  if not value:
    return None
  v = str(value).strip().strip('"').strip("'")
  if '@' in v:
    v = v.split('@', 1)[1]
  return v.lower()

def _local_repo_digests(img_attrs):
  digs = []
  try:
    for rd in (img_attrs.get("RepoDigests") or []):
      d = _digest_only(rd)
      if d and d not in digs:
        digs.append(d)
  except Exception:
    pass
  return digs

def _compute_stats(container):
  meta = {"state": None, "image": None, "cpu": None, "mem_usage": None, "mem_limit": None, "mem_perc": None,
          "net_rx": None, "net_tx": None, "blk_read": None, "blk_write": None}
  try:
    try:
      meta["state"] = container.status or container.attrs.get("State", {}).get("Status")
    except Exception:
      meta["state"] = None
    try:
      img_attrs = container.image.attrs or {}
      repo_tags = img_attrs.get("RepoTags") or container.image.tags or []
      if repo_tags:
        meta["image"] = repo_tags[0]
      else:
        repo_digests = img_attrs.get("RepoDigests") or []
        if repo_digests:
          repo = repo_digests[0].split("@")[0]
          meta["image"] = f"{repo}:latest"
    except Exception:
      pass
    stats = container.stats(stream=False)
    try:
      cpu_stats = stats.get("cpu_stats", {}); precpu = stats.get("precpu_stats", {})
      cpu_delta = (cpu_stats.get("cpu_usage", {}).get("total_usage", 0) - precpu.get("cpu_usage", {}).get("total_usage", 0))
      system_delta = (cpu_stats.get("system_cpu_usage", 0) - precpu.get("system_cpu_usage", 0))
      online_cpus = cpu_stats.get("online_cpus") or len(cpu_stats.get("cpu_usage", {}).get("percpu_usage", []) or []) or 1
      if cpu_delta > 0 and system_delta > 0:
        meta["cpu"] = (cpu_delta / system_delta) * online_cpus * 100.0
    except Exception:
      pass
    try:
      mem = stats.get("memory_stats", {}) or {}
      usage = mem.get("usage") or 0; limit = mem.get("limit") or 0
      meta["mem_usage"] = usage; meta["mem_limit"] = limit
      if limit: meta["mem_perc"] = (usage / limit) * 100.0
    except Exception:
      pass
    try:
      rx = tx = 0
      networks = stats.get("networks", {}) or {}
      for vals in networks.values():
        rx += int(vals.get("rx_bytes", 0) or 0)
        tx += int(vals.get("tx_bytes", 0) or 0)
      meta["net_rx"] = rx; meta["net_tx"] = tx
    except Exception:
      pass
    try:
      reads = writes = 0
      blk = stats.get("blkio_stats", {}).get("io_service_bytes_recursive") or []
      for item in blk:
        op = (item.get("op") or "").lower(); val = int(item.get("value") or 0)
        if op == "read": reads += val
        elif op == "write": writes += val
      meta["blk_read"] = reads; meta["blk_write"] = writes
    except Exception:
      pass
  except Exception:
    pass
  return meta

def _compute_light_meta(container):
  m = {"state": None, "image": None}
  try:
    m["state"] = container.status or container.attrs.get("State", {}).get("Status")
  except Exception:
    pass
  try:
    img_attrs = container.image.attrs or {}
    repo_tags = img_attrs.get("RepoTags") or container.image.tags or []
    if repo_tags:
      m["image"] = repo_tags[0]
    else:
      repo_digests = img_attrs.get("RepoDigests") or []
      if repo_digests:
        repo = repo_digests[0].split("@")[0]
        m["image"] = f"{repo}:latest"
  except Exception:
    pass
  return m

_stats_cache = {} 
_STATS_TTL = 2.0

def _compute_stats_cached(container):
  now = time.time()
  key = container.name
  cached = _stats_cache.get(key)
  if cached and (now - cached["ts"] < _STATS_TTL):
    return cached["meta"]
  meta = _compute_stats(container)
  _stats_cache[key] = {"ts": now, "meta": meta}
  return meta

def check_updates_for_containers(containers, *, force: bool = False):
  updates, meta = {}, {}
  now_ts = time.time()
  for container in containers:
    name = container.name
    try:
      img_attrs = container.image.attrs or {}
      repo_tags = img_attrs.get("RepoTags") or container.image.tags or []
      image_ref = repo_tags[0] if repo_tags else None
      if not image_ref:
        repo_digests = img_attrs.get("RepoDigests") or []
        if repo_digests:
          repo = repo_digests[0].split("@")[0]
          image_ref = f"{repo}:latest"
      if not image_ref:
        updates[name] = "unknown_image"; meta[name] = _compute_stats(container); continue
      local_digests = _local_repo_digests(img_attrs)
      if not local_digests:
        updates[name] = "unknown_local_digest"; meta[name] = _compute_stats(container); continue
      remote_digest = fetch_remote_digest_cached(image_ref, force=force, now_ts=now_ts)
      if not remote_digest:
        updates[name] = "registry_error"; meta[name] = _compute_stats(container); continue
      rdig = _digest_only(remote_digest)
      same = any(_digest_only(ld) == rdig for ld in local_digests)
      updates[name] = "up_to_date" if same else "update_available"
      meta[name] = _compute_stats(container)
    except Exception as e:
      updates[name] = f"error: {e}"
      meta[name] = {}
  return updates, meta

def check_updates_for_containers_light(containers, *, force: bool = False):
  updates, meta = {}, {}
  now_ts = time.time()
  for container in containers:
    name = container.name
    try:
      img_attrs = container.image.attrs or {}
      repo_tags = img_attrs.get("RepoTags") or container.image.tags or []
      image_ref = repo_tags[0] if repo_tags else None
      if not image_ref:
        repo_digests = img_attrs.get("RepoDigests") or []
        if repo_digests:
          repo = repo_digests[0].split("@")[0]
          image_ref = f"{repo}:latest"
      if not image_ref:
        updates[name] = "unknown_image"; meta[name] = _compute_light_meta(container); continue
      local_digests = _local_repo_digests(img_attrs)
      if not local_digests:
        updates[name] = "unknown_local_digest"; meta[name] = _compute_light_meta(container); continue
      remote_digest = fetch_remote_digest_cached(image_ref, force=force, now_ts=now_ts)
      if not remote_digest:
        updates[name] = "registry_error"; meta[name] = _compute_light_meta(container); continue
      rdig = _digest_only(remote_digest)
      same = any(_digest_only(ld) == rdig for ld in local_digests)
      updates[name] = "up_to_date" if same else "update_available"
      meta[name] = _compute_light_meta(container)
    except Exception as e:
      updates[name] = f"error: {e}"
      meta[name] = _compute_light_meta(container)
  return updates, meta

@app.route("/status")
def docker_status():
  if not _check_auth():
    return jsonify({"error": "unauthorized"}), 401
  force = request.args.get("force", "").lower() in ("1","true","yes")
  light = request.args.get("light", "").lower() in ("1","true","yes")
  containers = client.containers.list(all=True)
  if light:
    updates, meta = check_updates_for_containers_light(containers, force=force)
  else:
    updates, meta = check_updates_for_containers(containers, force=force)
  app.logger.info("/status(light=%s) -> %d containers", light, len(updates))
  return jsonify({"status": "ok","updates": {str(k): v for k, v in updates.items()},"meta": {str(k): v for k, v in meta.items()}})

@app.get("/metrics/<name>")
def metrics_one(name):
  if not _check_auth():
    return jsonify({"error": "unauthorized"}), 401
  try:
    c = client.containers.get(name)
  except docker.errors.NotFound:
    return jsonify({"error": "not_found"}), 404
  except Exception as e:
    return jsonify({"error": str(e)}), 500
  try:
    meta = _compute_stats_cached(c)
    return jsonify({"status": "ok", "meta": meta})
  except Exception as e:
    return jsonify({"status": "error", "error": str(e)}), 500

@app.get("/diag")
def diag():
  if not _check_auth():
    return jsonify({"ok": False, "error": "unauthorized"}), 401
  try:
    ok = client.ping()
  except Exception as e:
    return jsonify({"ok": False, "error": f"ping failed: {e}"}), 500
  try:
    names = [c.name for c in client.containers.list(all=True)]
  except Exception as e:
    return jsonify({"ok": False, "ping": ok, "error": f"list failed: {e}"}), 500
  sock = "/var/run/docker.sock"
  try:
    st = os.stat(sock)
    meta = {"socket_exists": True,"socket_mode": oct(st.st_mode & 0o777),"socket_uid": st.st_uid,"socket_gid": st.st_gid,"proc_uid": os.getuid(),"proc_gid": os.getgid()}
  except FileNotFoundError:
    meta = {"socket_exists": False}
  return jsonify({"ok": True, "ping": ok, "containers": names, "socket": meta})

@app.get("/status/<name>")
def docker_status_one(name):
  if not _check_auth():
    return jsonify({"error": "unauthorized"}), 401
  force = request.args.get("force", "").lower() in ("1","true","yes")
  light = request.args.get("light", "").lower() in ("1","true","yes")
  try:
    container = client.containers.get(name)
    if light:
      updates, meta = check_updates_for_containers_light([container], force=force)
    else:
      updates, meta = check_updates_for_containers([container], force=force)
    st = updates.get(container.name)
    app.logger.info("/status/%s (light=%s) -> %s", name, light, st)
    return jsonify({"status": "ok","updates": {str(container.name): st},"meta": {str(container.name): meta.get(container.name, {})}})
  except docker.errors.NotFound:
    return jsonify({"status": "ok","updates": {str(name): "not_found"},"meta": {str(name): {}}})
  except Exception as e:
    return jsonify({"status": "error", "error": str(e)}), 500

@app.post("/update_container")
def update_container():
  if not _check_auth():
    return jsonify({"error": "unauthorized"}), 401
  data = request.get_json(silent=True) or {}
  name = data.get("name")
  if not name:
    return jsonify({"error": "Missing 'name'"}), 400
  if SELF_CONTAINER_NAME and name == SELF_CONTAINER_NAME:
    return jsonify({"error": "self_update_blocked","message": "Ce service ne peut pas se mettre à jour lui-même via l’API. Mettez à jour le conteneur 'docker-monitor' depuis Portainer/Docker."}), 409
  try:
    container = client.containers.get(name)
  except docker.errors.NotFound:
    return jsonify({"error": "container not found"}), 404
  except Exception as e:
    return jsonify({"error": str(e)}), 500
  try:
    updates, _ = check_updates_for_containers([container], force=True)
    status = updates.get(container.name)
    if status == "up_to_date":
      return jsonify({"message": "already up to date", "updated": False}), 200
  except Exception as e:
    app.logger.info("failed to pre-check update for %s: %s", name, e)
  try:
    image_ref = (container.attrs.get("Config", {}) or {}).get("Image")
    if image_ref and "@sha256:" in image_ref:
      image_ref = image_ref.split("@")[0] + ":latest"
    if not image_ref:
      image_ref = container.image.tags[0] if container.image.tags else None
    if not image_ref:
      repo_digests = (container.image.attrs or {}).get("RepoDigests") or []
      if repo_digests:
        repo = repo_digests[0].split("@")[0]
        image_ref = f"{repo}:latest"
    if not image_ref:
      return jsonify({"error": "cannot determine image reference for update"}), 400
  except Exception as e:
    return jsonify({"error": str(e)}), 500
  try:
    client.images.pull(image_ref)
  except docker.errors.ImageNotFound:
    return jsonify({"error": "image not found to pull"}), 404
  except docker.errors.APIError as e:
    return jsonify({"error": f"docker api error: {e.explanation}"}), 500
  except Exception as e:
    return jsonify({"error": str(e)}), 500
  try:
    attrs = container.attrs
    config = attrs.get('Config', {}) or {}
    host_config = attrs.get('HostConfig', {}) or {}
    nets_cfg = (attrs.get('NetworkSettings', {}) or {}).get('Networks', {}) or {}
    env = config.get('Env') or None
    cmd = config.get('Cmd') or None
    entrypoint = config.get('Entrypoint') or None
    name_current = attrs.get('Name', '').lstrip('/') or name
    labels = config.get('Labels') or None
    working_dir = config.get('WorkingDir') or None
    user = config.get('User') or None
    port_bindings = host_config.get('PortBindings') or None
    binds = host_config.get('Binds') or None
    restart_policy = (host_config.get('RestartPolicy') or {}).get('Name')
    network_mode = host_config.get('NetworkMode') or None
    networks_to_connect = {}
    for net_name, params in nets_cfg.items():
      if not isinstance(params, dict): continue
      ipam = params.get("IPAMConfig") or {}
      networks_to_connect[net_name] = {
        "aliases": params.get("Aliases"),
        "links": params.get("Links"),
        "ipv4_address": (ipam.get("IPv4Address") or params.get("IPAddress")),
        "ipv6_address": ipam.get("IPv6Address"),
        "link_local_ips": ipam.get("LinkLocalIPs"),
      }
    try: container.stop(timeout=10)
    except Exception: pass
    try: container.remove()
    except Exception: pass
    hc = client.api.create_host_config(
      binds=binds, port_bindings=port_bindings,
      restart_policy={"Name": restart_policy} if restart_policy else None,
      network_mode=network_mode,
    )
    new_id = client.api.create_container(
      image=image_ref, name=name_current, command=cmd, environment=env,
      entrypoint=entrypoint, host_config=hc, working_dir=working_dir, user=user, labels=labels,
    )["Id"]
    def _is_special_network_mode(mode: Optional[str]) -> bool:
      if not mode: return False
      m = str(mode).lower()
      return m.startswith("container:") or m in ("host", "none")
    if not _is_special_network_mode(network_mode):
      for net_name, kw in networks_to_connect.items():
        try:
          client.api.connect_container_to_network(
            new_id, net_name,
            aliases=kw.get("aliases"), links=kw.get("links"),
            ipv4_address=kw.get("ipv4_address"), ipv6_address=kw.get("ipv6_address"),
            link_local_ips=kw.get("link_local_ips")
          )
        except Exception as e:
          app.logger.info("network connect failed on %s -> %s: %s", name_current, net_name, e)
    client.api.start(new_id)
    return jsonify({"message": "container recreated with latest image", "updated": True})
  except docker.errors.APIError as e:
    return jsonify({"error": f"docker api error: {e.explanation}"}), 500
  except Exception as e:
    return jsonify({"error": str(e)}), 500

def warm_remote_digest_cache():
  while True:
    try:
      for c in client.containers.list(all=True):
        tags = (c.image.attrs.get("RepoTags") or c.image.tags or [])
        if not tags: continue
        fetch_remote_digest_cached(tags[0], force=False)
    except Exception as e:
      logging.info("warm cache error: %s", e)
    time.sleep(900)

threading.Thread(target=warm_remote_digest_cache, daemon=True).start()

if GUI_ENABLED:
  @app.get("/")
  def index():
    return render_template("index.html")
  @app.get("/static/<path:filename>")
  def static_files(filename):
    return send_from_directory(app.static_folder, filename)
else:
  @app.get("/")
  def index_disabled():
    return jsonify({
      "status": "ok",
      "message": "GUI disabled. API endpoints are available.",
      "endpoints": ["/diag", "/status", "/metrics/<name>", "/update_container", "/images/unused", "/images/prune", "/settings"]
    })

if __name__ == "__main__":
  app.run(host="0.0.0.0", port=5000, threaded=True)