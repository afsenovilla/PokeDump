package io.github.afsenovilla.pokedump;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import com.hoho.android.usbserial.driver.CdcAcmSerialDriver;
import com.hoho.android.usbserial.driver.ProbeTable;
import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;
import com.hoho.android.usbserial.util.SerialInputOutputManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Puente entre la página web y el USB de Android: lo que Chrome ofrece como Web Serial (navigator.serial) aquí lo da
 * assets/android/po-serial.js, apoyado en estos métodos. Los métodos @JavascriptInterface se ejecutan en un hilo del WebView;
 * las respuestas a la página se envían con evaluateJavascript en el hilo principal.
 */
public class SerialBridge {
    private static final String ACTION_PERMISSION = "io.github.afsenovilla.pokedump.USB_PERMISSION";

    private static class Session {
        UsbSerialPort port;
        UsbDeviceConnection connection;
        SerialInputOutputManager manager;
        int controlInterface = -1;       // interfaz CDC de control (solo puertos CDC-ACM); -1 = usar el controlador de la librería
        boolean dtr = false;
        boolean rts = false;
    }

    private final Activity activity;
    private final WebView web;
    private final UsbManager usb;
    private final UsbSerialProber prober;
    private final Map<String, Session> sessions = new HashMap<>();
    private final Map<Integer, String> permissionRequests = new HashMap<>();   // idDispositivo -> petición de la página

    public SerialBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        this.usb = (UsbManager) activity.getSystemService(Context.USB_SERVICE);
        ProbeTable table = UsbSerialProber.getDefaultProbeTable();
        table.addProduct(0x303A, 0x1001, CdcAcmSerialDriver.class);   // ESP32-S3/C3/C6: USB-Serial/JTAG
        table.addProduct(0x303A, 0x0002, CdcAcmSerialDriver.class);   // ESP32-S2/S3: USB CDC del ROM
        table.addProduct(0x303A, 0x4001, CdcAcmSerialDriver.class);   // TinyUSB CDC
        this.prober = new UsbSerialProber(table);

        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_PERMISSION);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                handleBroadcast(intent);
            }
        };
        if (Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            activity.registerReceiver(receiver, filter);
        }
    }

    // ---- Lo que la página llama ----

    /** Dispositivos USB conectados que parecen un puerto serie: [{id, vid, pid, name, granted}] */
    @JavascriptInterface
    public String list() {
        JSONArray array = new JSONArray();
        for (UsbDevice device : usb.getDeviceList().values()) {
            if (!isSerial(device)) continue;
            array.put(describe(device));
        }
        return array.toString();
    }

    /** requestPort: filtros [{usbVendorId, usbProductId}]; responde con __poSerial.resolve / reject. */
    @JavascriptInterface
    public void request(final int requestId, String filtersJson) {
        final List<UsbDevice> candidates = new ArrayList<>();
        JSONArray filters;
        try {
            filters = new JSONArray(filtersJson);
        } catch (JSONException e) {
            filters = new JSONArray();
        }
        for (UsbDevice device : usb.getDeviceList().values()) {
            if (!isSerial(device)) continue;
            if (matches(device, filters)) candidates.add(device);
        }
        if (candidates.isEmpty()) {
            reject(requestId, "NotFoundError", "No hay ninguna placa conectada por USB (¿cable OTG?).");
            return;
        }
        if (candidates.size() == 1) {
            ensurePermission(requestId, candidates.get(0));
            return;
        }
        final String[] names = new String[candidates.size()];
        for (int i = 0; i < names.length; i++) {
            UsbDevice d = candidates.get(i);
            names[i] = (d.getProductName() != null ? d.getProductName() : "USB") + String.format(" (%04X:%04X)", d.getVendorId(), d.getProductId());
        }
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                new AlertDialog.Builder(activity)
                        .setTitle("Elige la placa")
                        .setItems(names, (dialog, which) -> ensurePermission(requestId, candidates.get(which)))
                        .setOnCancelListener(dialog -> reject(requestId, "NotFoundError", "No se eligió ninguna placa."))
                        .show();
            }
        });
    }

    @JavascriptInterface
    public synchronized boolean open(String id, int baudRate) {
        UsbDevice device = find(id);
        if (device == null || !usb.hasPermission(device)) return false;
        close(id);
        UsbSerialDriver driver = prober.probeDevice(device);
        if (driver == null || driver.getPorts().isEmpty()) return false;
        UsbDeviceConnection connection = usb.openDevice(device);
        if (connection == null) return false;
        UsbSerialPort port = driver.getPorts().get(0);
        try {
            port.open(connection);
            port.setParameters(baudRate > 0 ? baudRate : 115200, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE);
        } catch (Exception e) {
            try { port.close(); } catch (Exception ignored) { }
            connection.close();
            return false;
        }
        final Session session = new Session();
        session.port = port;
        session.connection = connection;
        if (driver instanceof CdcAcmSerialDriver) {
            for (int i = 0; i < device.getInterfaceCount(); i++) {
                if (device.getInterface(i).getInterfaceClass() == 2) {      // USB_CLASS_COMM
                    session.controlInterface = device.getInterface(i).getId();
                    break;
                }
            }
        }
        setLines(session, 1, 1);     // como al abrir un puerto en un ordenador: DTR y RTS activados, a la vez
        final String sessionId = id;
        session.manager = new SerialInputOutputManager(port, new SerialInputOutputManager.Listener() {
            @Override
            public void onNewData(byte[] data) {
                final String encoded = Base64.encodeToString(data, Base64.NO_WRAP);
                call("window.__poSerial.data(" + JSONObject.quote(sessionId) + "," + JSONObject.quote(encoded) + ")");
            }

            @Override
            public void onRunError(Exception e) {
                call("window.__poSerial.lost(" + JSONObject.quote(sessionId) + "," + JSONObject.quote(String.valueOf(e.getMessage())) + ")");
            }
        });
        session.manager.setReadBufferSize(16384);
        session.manager.start();
        sessions.put(id, session);
        return true;
    }

    /** Escribe y devuelve los bytes escritos, o -1 si falló. */
    @JavascriptInterface
    public int write(String id, String base64) {
        Session session;
        synchronized (this) {
            session = sessions.get(id);
        }
        if (session == null) return -1;
        byte[] data = Base64.decode(base64, Base64.NO_WRAP);
        try {
            session.port.write(data, 5000);
            return data.length;
        } catch (IOException e) {
            return -1;
        }
    }

    /** dtr/rts: 1 = activar, 0 = soltar, -1 = no tocar. */
    @JavascriptInterface
    public boolean signals(String id, int dtr, int rts) {
        Session session;
        synchronized (this) {
            session = sessions.get(id);
        }
        if (session == null) return false;
        return setLines(session, dtr, rts);
    }

    /**
     * DTR y RTS. En los puertos CDC-ACM (las placas con USB nativo: ESP32-S3/C3/C6) los dos cambian en UNA sola orden de control
     * (SET_CONTROL_LINE_STATE), como hace Chrome de escritorio: el USB-Serial/JTAG de la placa interpreta la secuencia de estados
     * como el circuito de auto-reset, y cambiarlos uno a uno pasa por estados que la dejan en el bootloader.
     */
    private boolean setLines(Session session, int dtr, int rts) {
        if (dtr >= 0) session.dtr = dtr == 1;
        if (rts >= 0) session.rts = rts == 1;
        try {
            if (session.controlInterface >= 0) {
                int value = (session.dtr ? 1 : 0) | (session.rts ? 2 : 0);
                return session.connection.controlTransfer(0x21, 0x22, value, session.controlInterface, null, 0, 500) >= 0;
            }
            if (dtr >= 0) session.port.setDTR(session.dtr);
            if (rts >= 0) session.port.setRTS(session.rts);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public synchronized void close(String id) {
        Session session = sessions.remove(id);
        if (session == null) return;
        if (session.manager != null) session.manager.stop();
        try { session.port.close(); } catch (Exception ignored) { }
        try { session.connection.close(); } catch (Exception ignored) { }
    }

    /** Guarda un archivo en Descargas (la página lo pide en lugar de «descargar» un blob). Devuelve una descripción del destino. */
    @JavascriptInterface
    public String saveFile(final String name, String mime, String base64) {
        byte[] data = Base64.decode(base64, Base64.NO_WRAP);
        String where;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/PokeDump");
                Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IOException("no se pudo crear el archivo");
                try (OutputStream out = activity.getContentResolver().openOutputStream(uri)) {
                    out.write(data);
                }
                where = "Descargas/PokeDump/" + name;
            } else {
                File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                File file = new File(dir, name);
                try (OutputStream out = new FileOutputStream(file)) {
                    out.write(data);
                }
                where = file.getAbsolutePath();
            }
        } catch (IOException e) {
            where = "ERROR: " + e.getMessage();
        }
        final String message = where.startsWith("ERROR") ? where : "Guardado en " + where;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
            }
        });
        return where;
    }

    // ---- Interno ----

    private void handleBroadcast(Intent intent) {
        String action = intent.getAction();
        UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
        if (ACTION_PERMISSION.equals(action)) {
            if (device == null) return;
            Integer requestId;
            synchronized (this) {
                requestId = null;
                for (Map.Entry<Integer, String> entry : permissionRequests.entrySet()) {
                    if (entry.getValue().equals(device.getDeviceName())) requestId = entry.getKey();
                }
                if (requestId != null) permissionRequests.remove(requestId);
            }
            if (requestId == null) return;
            if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
                resolve(requestId, device);
            } else {
                reject(requestId, "NotAllowedError", "Android no dio permiso para usar la placa.");
            }
        } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action) && device != null && isSerial(device)) {
            call("window.__poSerial.attached(" + describe(device) + ")");
        } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action) && device != null) {
            close(device.getDeviceName());
            call("window.__poSerial.detached(" + JSONObject.quote(device.getDeviceName()) + ")");
        }
    }

    private void ensurePermission(int requestId, UsbDevice device) {
        if (usb.hasPermission(device)) {
            resolve(requestId, device);
            return;
        }
        synchronized (this) {
            permissionRequests.put(requestId, device.getDeviceName());
        }
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        Intent intent = new Intent(ACTION_PERMISSION).setPackage(activity.getPackageName());
        usb.requestPermission(device, PendingIntent.getBroadcast(activity, 0, intent, flags));
    }

    private UsbDevice find(String id) {
        for (UsbDevice device : usb.getDeviceList().values()) {
            if (device.getDeviceName().equals(id)) return device;
        }
        return null;
    }

    private boolean isSerial(UsbDevice device) {
        if (prober.probeDevice(device) != null) return true;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            int cls = device.getInterface(i).getInterfaceClass();
            if (cls == 2 || cls == 10) return true;     // CDC control / CDC data
        }
        return false;
    }

    private boolean matches(UsbDevice device, JSONArray filters) {
        if (filters.length() == 0) return true;
        for (int i = 0; i < filters.length(); i++) {
            JSONObject filter = filters.optJSONObject(i);
            if (filter == null) continue;
            if (filter.has("usbVendorId") && filter.optInt("usbVendorId") != device.getVendorId()) continue;
            if (filter.has("usbProductId") && filter.optInt("usbProductId") != device.getProductId()) continue;
            return true;
        }
        return false;
    }

    private JSONObject describe(UsbDevice device) {
        JSONObject object = new JSONObject();
        try {
            object.put("id", device.getDeviceName());
            object.put("vid", device.getVendorId());
            object.put("pid", device.getProductId());
            object.put("name", device.getProductName() != null ? device.getProductName() : "USB");
            object.put("granted", usb.hasPermission(device));
        } catch (JSONException ignored) { }
        return object;
    }

    private void resolve(int requestId, UsbDevice device) {
        call("window.__poSerial.resolve(" + requestId + "," + describe(device) + ")");
    }

    private void reject(int requestId, String name, String message) {
        call("window.__poSerial.reject(" + requestId + "," + JSONObject.quote(name) + "," + JSONObject.quote(message) + ")");
    }

    private void call(final String script) {
        web.post(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript("(function(){try{" + script + "}catch(e){}})()", null);
            }
        });
    }
}
