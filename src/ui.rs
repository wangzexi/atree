use axum::http::{HeaderMap, header};

pub(crate) fn wants_html(headers: &HeaderMap) -> bool {
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !accept
        .split(',')
        .any(|part| part.trim().starts_with("text/html"))
    {
        return false;
    }
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    ![
        "curl",
        "wget",
        "aws-cli",
        "boto3",
        "restic",
        "rclone",
        "go-http-client",
        "python-requests",
    ]
    .iter()
    .any(|tool| ua.contains(tool))
}

pub(crate) fn file_browser_html(
    bucket: &str,
    virtual_path: &str,
    directory_entries_json: &str,
    directory_error_json: &str,
) -> String {
    let bucket_json = serde_json::to_string(bucket).unwrap_or_else(|_| "\"quark\"".to_string());
    let path_json = serde_json::to_string(virtual_path).unwrap_or_else(|_| "\"/\"".to_string());
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>atree</title>
  <style>
    :root {{ color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    body {{ margin: 0; background: #ffffff; color: #111827; }}
    header {{ display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 24px; border-bottom: 1px solid #e5e7eb; background: #ffffff; }}
    main {{ max-width: 960px; margin: 0 auto; padding: 24px 24px 48px; }}
    input {{ font: inherit; }}
    input {{ min-width: 240px; border: 1px solid #d1d5db; border-radius: 8px; padding: 9px 12px; background: #ffffff; color: #111827; }}
    input:focus {{ outline: none; border-color: #93c5fd; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12); }}
    .bar {{ margin-bottom: 18px; }}
    .auth {{ display: flex; justify-content: flex-end; }}
    .crumbs {{ display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 16px; line-height: 1.5; font-weight: 600; color: #9ca3af; }}
    .crumbs a {{ color: #2563eb; text-decoration: none; }}
    .crumbs a:hover {{ color: #1d4ed8; }}
    .table-wrap {{ border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; background: #ffffff; }}
    table {{ width: 100%; border-collapse: collapse; }}
    thead tr {{ background: #f9fafb; border-bottom: 1px solid #e5e7eb; }}
    th, td {{ padding: 14px 16px; border-bottom: 1px solid #e5e7eb; text-align: left; }}
    tbody tr:hover {{ background: #f9fafb; }}
    tbody tr:last-child td {{ border-bottom: none; }}
    th {{ font-size: 13px; font-weight: 600; color: #374151; }}
    th.size, td.size {{ width: 120px; text-align: right; }}
    th.time, td.time {{ width: 140px; text-align: right; white-space: nowrap; }}
    td {{ font-size: 14px; }}
    td a {{ color: #2563eb; text-decoration: none; font-weight: 500; }}
    td a:hover {{ color: #1d4ed8; }}
    .muted {{ color: #6b7280; }}
    .error {{ color: #b42318; }}
    .help {{ margin-top: 14px; font-size: 12px; color: #6b7280; word-break: break-all; }}
    .help code {{ font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; }}
    .brand {{ font-size: 20px; font-weight: 700; color: #111827; text-decoration: none; }}
    .brand:hover {{ color: #374151; }}
  </style>
</head>
<body>
  <header>
    <a class="brand" href="/">atree</a>
    <div class="auth">
      <input id="keyInput" type="text" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="访问 key">
    </div>
  </header>
  <main>
    <div class="bar">
      <nav id="crumbs" class="crumbs"></nav>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>名称</th><th class="size">大小</th><th class="time">更新时间</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div id="helpLine" class="help"></div>
  </main>
  <script>
    var BUCKET = {bucket_json};
    var INITIAL_PATH = {path_json};
    var DIRECTORY_ENTRIES = {directory_entries_json};
    var DIRECTORY_ERROR = {directory_error_json};
    var keyName = 'atree_key';
    var keyInput = document.getElementById('keyInput');
    var rows = document.getElementById('rows');
    var crumbs = document.getElementById('crumbs');
    var helpLine = document.getElementById('helpLine');

    function startsWith(value, prefix) {{
      return value.slice(0, prefix.length) === prefix;
    }}
    function decodePathPart(value) {{
      try {{
        return decodeURIComponent(value);
      }} catch (err) {{
        return value;
      }}
    }}
    function currentKey() {{ return localStorage.getItem(keyName) || ''; }}
    function setAuthState() {{
      var key = currentKey();
      if (keyInput.value !== key) keyInput.value = key;
    }}
    function s3Path() {{
      var path = location.pathname === '/' ? '/' + BUCKET + '/' : location.pathname;
      return path.slice(-1) === '/' ? path : path + '/';
    }}
    function keyPrefixFromPath() {{
      var parts = s3Path().split('/').filter(Boolean);
      if (parts[0] === BUCKET) parts.shift();
      for (var i = 0; i < parts.length; i += 1) {{
        parts[i] = decodePathPart(parts[i]);
      }}
      return parts.length ? parts.join('/') + '/' : '';
    }}
    function listUrl() {{
      var u = new URL(s3Path(), location.origin);
      u.searchParams.set('list-type', '2');
      u.searchParams.set('delimiter', '/');
      var prefix = keyPrefixFromPath();
      if (prefix) u.searchParams.set('prefix', prefix);
      return u;
    }}
    function browserListUrl() {{
      var u = new URL(location.pathname, location.origin);
      u.searchParams.set('atree-browser-list', '1');
      return u;
    }}
    function isSyntheticPath() {{
      return location.pathname !== '/' && !startsWith(location.pathname, '/' + BUCKET + '/');
    }}
    function headers(accept) {{
      var h = {{ Accept: accept || 'application/xml' }};
      var key = currentKey();
      if (key) h.Authorization = 'Bearer ' + key;
      return h;
    }}
    function xmlNodes(node, name) {{
      if (!node) return [];
      if (node.getElementsByTagNameNS) {{
        var nsNodes = node.getElementsByTagNameNS('*', name);
        if (nsNodes && nsNodes.length) return Array.prototype.slice.call(nsNodes);
      }}
      return Array.prototype.slice.call(node.getElementsByTagName(name));
    }}
    function firstXmlNode(node, name) {{
      var nodes = xmlNodes(node, name);
      return nodes.length ? nodes[0] : null;
    }}
    function xmlText(node, name) {{
      var found = firstXmlNode(node, name);
      return found ? (found.textContent || '') : '';
    }}
    function fmtBytes(n) {{
      if (!n) return '';
      var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
      var v = Number(n);
      var i = 0;
      while (v >= 1024 && i < units.length - 1) {{
        v /= 1024;
        i += 1;
      }}
      return (i ? v.toFixed(1) : v.toFixed(0)) + ' ' + units[i];
    }}
    function looksInline(contentType) {{
      return /^text\//.test(contentType)
        || /json|xml|yaml|yml|javascript|markdown/.test(contentType)
        || /^image\//.test(contentType)
        || /^audio\//.test(contentType)
        || /^video\//.test(contentType)
        || contentType === 'application/pdf';
    }}
    function fileNameFromDisposition(value) {{
      if (!value) return '';
      var utf8 = value.match(/filename\\*=UTF-8''([^;]+)/i);
      if (utf8) return decodeURIComponent(utf8[1]);
      var plain = value.match(/filename=\"?([^\";]+)\"?/i);
      return plain ? plain[1] : '';
    }}
    function fallbackFileName(href, name) {{
      if (name) return name;
      try {{
        var url = new URL(href, location.origin);
        var part = url.pathname.split('/').filter(Boolean).pop();
        return part ? decodeURIComponent(part) : 'download';
      }} catch (err) {{
        return 'download';
      }}
    }}
    function escapeHtml(text) {{
      var value = String(text);
      value = value.replace(/&/g, '&amp;');
      value = value.replace(/</g, '&lt;');
      value = value.replace(/>/g, '&gt;');
      return value;
    }}
    function blobToNamedObjectUrl(blob, contentType, downloadName) {{
      var namedBlob = blob;
      if (typeof File === 'function') {{
        try {{
          namedBlob = new File([blob], downloadName, {{ type: contentType || blob.type || 'application/octet-stream' }});
        }} catch (err) {{
          namedBlob = blob;
        }}
      }}
      return URL.createObjectURL(namedBlob);
    }}
    function readTextBlob(blob) {{
      return new Promise(function(resolve, reject) {{
        var reader = new FileReader();
        reader.onload = function() {{ resolve(String(reader.result || '')); }};
        reader.onerror = function() {{ reject(reader.error || new Error('read failed')); }};
        reader.readAsText(blob);
      }});
    }}
    function openInlinePreview(blob, objectUrl, contentType, downloadName) {{
      var popup = window.open('', '_blank');
      if (!popup) {{
        location.href = objectUrl;
        return Promise.resolve();
      }}
      var safeName = escapeHtml(downloadName);
      function writePreview(body) {{
        var html = ''
          + '<!doctype html><html lang="zh-CN"><head>'
          + '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
          + '<title>' + safeName + '</title>'
          + '<style>'
          + ':root {{ color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}'
          + 'body {{ margin: 0; background: Canvas; color: CanvasText; }}'
          + 'header {{ display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }}'
          + 'strong {{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}'
          + 'a {{ color: LinkText; text-decoration: none; }}'
          + 'main {{ padding: 16px; }}'
          + 'pre {{ margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; }}'
          + 'img, video, audio, iframe {{ width: 100%; max-width: 100%; border: 0; }}'
          + 'iframe {{ min-height: calc(100vh - 90px); background: white; }}'
          + '</style></head><body>'
          + '<header><strong>' + safeName + '</strong><a href="' + objectUrl + '" download="' + safeName + '">下载</a></header>'
          + '<main>' + body + '</main></body></html>';
        popup.document.open();
        popup.document.write(html);
        popup.document.close();
      }}
      if (/^text\//.test(contentType) || /json|xml|yaml|yml|javascript|markdown/.test(contentType)) {{
        return readTextBlob(blob).then(function(text) {{
          writePreview('<pre>' + escapeHtml(text) + '</pre>');
        }});
      }}
      if (/^image\//.test(contentType)) {{
        writePreview('<img src="' + objectUrl + '" alt="' + safeName + '">');
        return Promise.resolve();
      }}
      if (/^audio\//.test(contentType)) {{
        writePreview('<audio controls autoplay src="' + objectUrl + '"></audio>');
        return Promise.resolve();
      }}
      if (/^video\//.test(contentType)) {{
        writePreview('<video controls autoplay src="' + objectUrl + '"></video>');
        return Promise.resolve();
      }}
      writePreview('<iframe src="' + objectUrl + '" title="' + safeName + '"></iframe>');
      return Promise.resolve();
    }}
    function openFile(href, name) {{
      renderStatus('加载文件...', false);
      return fetch(href, {{ headers: headers('*/*') }})
        .then(function(res) {{
          if (res.status === 403 || res.status === 401) {{
            renderStatus('需要访问 key。', true);
            return null;
          }}
          if (!res.ok) {{
            renderStatus('文件失败：' + res.status, true);
            return null;
          }}
          return res.blob().then(function(blob) {{
            var contentType = (res.headers.get('content-type') || '').toLowerCase();
            var downloadName = fileNameFromDisposition(res.headers.get('content-disposition')) || fallbackFileName(href, name);
            var objectUrl = blobToNamedObjectUrl(blob, contentType, downloadName);
            if (looksInline(contentType)) {{
              return openInlinePreview(blob, objectUrl, contentType, downloadName).then(function() {{
                load();
              }});
            }}
            var a = document.createElement('a');
            a.href = objectUrl;
            a.download = downloadName;
            document.body.appendChild(a);
            a.click();
            if (a.parentNode) a.parentNode.removeChild(a);
            setTimeout(function() {{ URL.revokeObjectURL(objectUrl); }}, 1000);
            load();
            return null;
          }});
        }});
    }}
    function renderCrumbs() {{
      var rootLink = '<a href="/">/</a>';
      if (location.pathname === '/') {{
        crumbs.innerHTML = rootLink;
        return;
      }}
      if (!startsWith(location.pathname, '/' + BUCKET + '/')) {{
        var parts = location.pathname.split('/').filter(Boolean);
        var links = [rootLink];
        var acc = '';
        for (var i = 0; i < parts.length; i += 1) {{
          acc += '/' + encodeURIComponent(parts[i]);
          links.push('<span>/</span><a href="' + acc + '/">' + escapeHtml(decodePathPart(parts[i])) + '</a>');
        }}
        crumbs.innerHTML = links.join('');
        return;
      }}
      var bucketParts = keyPrefixFromPath().split('/').filter(Boolean);
      var bucketLinks = [rootLink, '<span>/</span><a href="/' + BUCKET + '/">' + escapeHtml(BUCKET) + '</a>'];
      var bucketAcc = '';
      for (var j = 0; j < bucketParts.length; j += 1) {{
        bucketAcc += encodeURIComponent(bucketParts[j]) + '/';
        bucketLinks.push('<span>/</span><a href="/' + BUCKET + '/' + bucketAcc + '">' + escapeHtml(decodePathPart(bucketParts[j])) + '</a>');
      }}
      crumbs.innerHTML = bucketLinks.join('');
    }}
    function renderItems(items) {{
      if (!items.length) {{
        rows.innerHTML = '<tr><td colspan="3" class="muted">空目录</td></tr>';
        return;
      }}
      var html = '';
      for (var i = 0; i < items.length; i += 1) {{
        var item = items[i];
        html += '<tr><td>'
          + '<a data-kind="' + escapeHtml(item.type) + '" href="' + escapeHtml(item.href) + '">' + escapeHtml(item.name) + '</a></td>'
          + '<td class="size">' + (item.type === 'file' ? fmtBytes(item.size) : '') + '</td>'
          + '<td class="time muted">' + escapeHtml(item.time || '') + '</td></tr>';
      }}
      rows.innerHTML = html;
    }}
    function renderStatus(text, isError) {{
      rows.innerHTML = '<tr><td colspan="3" class="' + (isError ? 'error' : 'muted') + '">' + escapeHtml(text) + '</td></tr>';
    }}
    function load() {{
      setAuthState();
      renderCrumbs();
      renderStatus('加载中...', false);
      if (DIRECTORY_ERROR) {{
        renderStatus(DIRECTORY_ERROR, true);
        return Promise.resolve();
      }}
      if (Array.isArray(DIRECTORY_ENTRIES)) {{
        renderItems(DIRECTORY_ENTRIES);
        return Promise.resolve();
      }}
      if (isSyntheticPath()) {{
        return fetch(browserListUrl(), {{ headers: headers('application/json') }})
          .then(function(res) {{
            if (res.status === 403 || res.status === 401) {{
              renderStatus('需要访问 key。', true);
              return null;
            }}
            if (!res.ok) {{
              renderStatus('列表失败：' + res.status, true);
              return null;
            }}
            return res.json().then(function(items) {{
              renderItems(items);
            }});
          }});
      }}
      return fetch(listUrl(), {{ headers: headers() }})
        .then(function(res) {{
          if (res.status === 403 || res.status === 401) {{
            renderStatus('需要访问 key。', true);
            return null;
          }}
          if (!res.ok) {{
            renderStatus('列表失败：' + res.status, true);
            return null;
          }}
          return res.text().then(function(xmlBody) {{
            var doc = new DOMParser().parseFromString(xmlBody, 'application/xml');
            var prefix = xmlText(doc, 'Prefix') || keyPrefixFromPath();
            var items = [];
            var prefixes = xmlNodes(doc, 'CommonPrefixes');
            for (var i = 0; i < prefixes.length; i += 1) {{
              var full = xmlText(prefixes[i], 'Prefix');
              var name = full.slice(prefix.length).replace(/\/$/, '');
              if (name) items.push({{ type: 'dir', name: name, href: '/' + BUCKET + '/' + full }});
            }}
            var contents = xmlNodes(doc, 'Contents');
            for (var j = 0; j < contents.length; j += 1) {{
              var fullKey = xmlText(contents[j], 'Key');
              var fileName = fullKey.slice(prefix.length);
              if (!fileName || fileName.indexOf('/') >= 0) continue;
              items.push({{
                type: 'file',
                name: fileName,
                href: '/' + BUCKET + '/' + fullKey,
                size: xmlText(contents[j], 'Size'),
                time: xmlText(contents[j], 'LastModified')
              }});
            }}
            renderItems(items);
          }});
        }});
    }}
    function findFileLink(target) {{
      while (target && target !== rows) {{
        if (target.tagName === 'A' && target.getAttribute('data-kind') === 'file') return target;
        target = target.parentNode;
      }}
      return null;
    }}
    helpLine.innerHTML = "<code>curl -H 'Authorization: Bearer &lt;root-key&gt;' '"
      + escapeHtml(location.origin) + "/api/config.yaml'</code>";
    keyInput.addEventListener('blur', function() {{
      var next = keyInput.value.replace(/^\s+|\s+$/g, '');
      var prev = currentKey();
      if (next) {{
        localStorage.setItem(keyName, next);
      }} else {{
        localStorage.removeItem(keyName);
      }}
      if (next !== prev) {{
        load().then(null, function(err) {{
          renderStatus(err && err.message ? err.message : String(err), true);
        }});
      }} else {{
        setAuthState();
      }}
    }});
    keyInput.addEventListener('keydown', function(event) {{
      if (event.key === 'Enter') keyInput.blur();
    }});
    rows.addEventListener('click', function(event) {{
      var link = findFileLink(event.target);
      if (!link) return;
      event.preventDefault();
      openFile(link.href, link.textContent || 'download').then(null, function(err) {{
        renderStatus(err && err.message ? err.message : String(err), true);
      }});
    }});
    load().then(null, function(err) {{
      renderStatus(err && err.message ? err.message : String(err), true);
    }});
  </script>
</body>
</html>"#
    )
}
