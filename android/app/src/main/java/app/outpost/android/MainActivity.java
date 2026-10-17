package app.outpost.android;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.OutputStream;
import java.net.URLEncoder;

/**
 * Outpost for Android: a thin shell around the same phone page the server serves.
 * Everything runs on the server; this app only remembers the server address and
 * handles what a plain WebView can't (picking files, saving and sharing files, opening links outside).
 */
public class MainActivity extends Activity {
    private static final int PICK = 1;
    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> pending;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("outpost", MODE_PRIVATE);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        String ver = "0";
        try { ver = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) { }
        s.setUserAgentString(s.getUserAgentString() + " OutpostAndroid/" + ver);
        web.addJavascriptInterface(new Bridge(), "OutpostNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String server = prefs.getString("server", "");
                if ("file".equals(u.getScheme())) return false;
                if (!server.isEmpty() && u.toString().startsWith(server) && !u.getPath().startsWith("/preview/")) return false;
                openOutside(u.toString());
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame() && !r.getUrl().toString().startsWith("file:")) showSetup(String.valueOf(e.getDescription()));
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (pending != null) pending.onReceiveValue(null);
                pending = cb;
                Intent i = p.createIntent();
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(i, PICK); } catch (Exception ex) { pending = null; return false; }
                return true;
            }
        });
        if (state != null) web.restoreState(state);
        else if (prefs.getString("server", "").isEmpty()) showSetup(null);
        else web.loadUrl(prefs.getString("server", ""));
    }

    private void showSetup(String error) {
        String url = prefs.getString("server", "");
        StringBuilder q = new StringBuilder("file:///android_asset/setup.html?x=1");
        try {
            if (!url.isEmpty()) q.append("&url=").append(URLEncoder.encode(url, "UTF-8"));
            if (error != null) q.append("&error=").append(URLEncoder.encode(error, "UTF-8"));
        } catch (Exception ignored) { }
        web.loadUrl(q.toString());
    }

    private void openOutside(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception e) { Toast.makeText(this, "没有可以打开链接的应用", Toast.LENGTH_SHORT).show(); }
    }

    /** Save into the phone's Downloads folder (no storage permission needed on Android 10+). */
    private Uri saveToDownloads(String name, String mime, String b64) throws Exception {
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, name);
        v.put(MediaStore.Downloads.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
        v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Outpost");
        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new Exception("无法保存");
        try (OutputStream os = getContentResolver().openOutputStream(uri)) { os.write(Base64.decode(b64, Base64.DEFAULT)); }
        return uri;
    }

    private class Bridge {
        @JavascriptInterface public void setServer(String url) {
            prefs.edit().putString("server", url).apply();
            runOnUiThread(() -> web.loadUrl(url));
        }
        @JavascriptInterface public void resetServer() {
            runOnUiThread(() -> showSetup(null));
        }
        @JavascriptInterface public String server() { return prefs.getString("server", ""); }
        @JavascriptInterface public void openUrl(String url) {
            String abs = url.startsWith("/") ? prefs.getString("server", "") + url : url;
            runOnUiThread(() -> openOutside(abs));
        }
        @JavascriptInterface public void saveFile(String name, String mime, String b64) {
            runOnUiThread(() -> {
                try {
                    Uri u = saveToDownloads(name, mime, b64);
                    Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(u, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try { startActivity(i); } catch (Exception e) { Toast.makeText(MainActivity.this, "已保存到 下载/Outpost", Toast.LENGTH_SHORT).show(); }
                } catch (Exception e) { Toast.makeText(MainActivity.this, "保存失败：" + e.getMessage(), Toast.LENGTH_SHORT).show(); }
            });
        }
        @JavascriptInterface public void shareFile(String name, String mime, String b64) {
            runOnUiThread(() -> {
                try {
                    Uri u = saveToDownloads(name, mime, b64);
                    Intent i = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, u).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(i, name));
                } catch (Exception e) { Toast.makeText(MainActivity.this, "分享失败：" + e.getMessage(), Toast.LENGTH_SHORT).show(); }
            });
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == PICK && pending != null) {
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    out = new Uri[data.getClipData().getItemCount()];
                    for (int k = 0; k < out.length; k++) out[k] = data.getClipData().getItemAt(k).getUri();
                } else if (data.getData() != null) out = new Uri[]{ data.getData() };
            }
            pending.onReceiveValue(out);
            pending = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
}
