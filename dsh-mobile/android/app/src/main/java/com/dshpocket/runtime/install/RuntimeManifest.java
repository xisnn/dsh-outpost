package com.dshpocket.runtime.install;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.TreeMap;

/**
 * Immutable distribution identity pinned by the application, not supplied by a download.
 * The caller MUST obtain this JSON from a trusted bundled asset or equivalent app constant.
 * No signature verification or trust inference from an archive/adjacent manifest is performed.
 */
public final class RuntimeManifest {
    public static final int FORMAT_VERSION = 1;
    public static final int MAX_ENTRIES = 65536;
    public static final long MAX_UNPACKED_BYTES = 8L * 1024 * 1024 * 1024;

    public final String id;
    public final String version;
    public final String abi;
    public final int dataSchema;
    public final String archiveSha256;
    public final long maxUnpackedBytes;
    public final String entrypoint;
    /** Exact Node and DSH versions; the pinned inventory binds these claims to bytes. */
    public final String nodeVersion;
    public final String dshVersion;
    public final String inventorySha256;
    public final SortedMap<String, Entry> files;
    public final List<String> requiredDirectories;

    public static final class Entry {
        public final String path;
        public final String type;
        public final int mode;
        public final long size;
        public final String sha256;
        public final String target;

        private Entry(String path, String type, int mode, long size, String sha256, String target) {
            this.path = path;
            this.type = type;
            this.mode = mode;
            this.size = size;
            this.sha256 = sha256;
            this.target = target;
        }
    }

    private RuntimeManifest(JSONObject json) throws IOException, JSONException {
        exactKeys(json, "formatVersion", "id", "version", "abi", "dataSchema", "archiveSha256",
                "maxUnpackedBytes", "entrypoint", "nodeVersion", "dshVersion",
                "inventorySha256", "requiredDirectories", "files");
        require(integer(json, "formatVersion") == FORMAT_VERSION, "Unsupported manifest format");
        id = token(string(json, "id"), "id");
        version = token(string(json, "version"), "version");
        abi = token(string(json, "abi"), "abi");
        long schema = integer(json, "dataSchema");
        require(schema >= 0 && schema <= Integer.MAX_VALUE, "Invalid data schema");
        dataSchema = (int) schema;
        archiveSha256 = digestString(string(json, "archiveSha256"));
        maxUnpackedBytes = integer(json, "maxUnpackedBytes");
        require(maxUnpackedBytes > 0 && maxUnpackedBytes <= MAX_UNPACKED_BYTES,
                "Invalid unpacked byte limit");
        entrypoint = path(string(json, "entrypoint"));
        nodeVersion = exactVersion(string(json, "nodeVersion"));
        dshVersion = exactVersion(string(json, "dshVersion"));
        inventorySha256 = digestString(string(json, "inventorySha256"));
        files = Collections.unmodifiableSortedMap(parseInventory(json.getJSONArray("files")));
        require(inventorySha256.equals(inventoryDigest(files)), "Pinned inventory digest mismatch");
        long total = 0;
        for (Entry entry : files.values()) {
            require(entry.size <= maxUnpackedBytes - total, "Inventory exceeds unpacked byte limit");
            total += entry.size;
        }
        Entry executable = files.get(entrypoint);
        require(executable != null && "file".equals(executable.type)
                && (executable.mode & 0100) != 0, "Entrypoint must be an owner-executable regular file");
        JSONArray dirs = json.getJSONArray("requiredDirectories");
        require(dirs.length() > 0 && dirs.length() <= MAX_ENTRIES, "Required directories missing");
        List<String> required = new ArrayList<>();
        Set<String> unique = new HashSet<>();
        for (int i = 0; i < dirs.length(); i++) {
            require(dirs.get(i) instanceof String, "Directory path must be a string");
            String directory = path(dirs.getString(i));
            Entry entry = files.get(directory);
            require(unique.add(directory) && entry != null && "dir".equals(entry.type),
                    "Required directory absent or duplicated: " + directory);
            required.add(directory);
        }
        Collections.sort(required);
        requiredDirectories = Collections.unmodifiableList(required);
    }

    /** Only for JSON already trusted by the app; never call on downloaded JSON. */
    public static RuntimeManifest fromTrustedAppJson(JSONObject appPinnedJson) throws IOException {
        if (appPinnedJson == null) throw new IOException("Trusted manifest is required");
        try {
            return new RuntimeManifest(appPinnedJson);
        } catch (JSONException | IllegalArgumentException exception) {
            throw new IOException("Malformed trusted runtime manifest", exception);
        }
    }

    /**
     * Fixture/tool helper. This computes a digest, it DOES NOT authenticate the supplied inventory.
     * UTF-8 canonical form starts with "dsh-runtime-inventory-v1\n", then, in ASCII path order:
     * type TAB path TAB four-digit-octal-mode TAB decimal-size TAB sha256-or-'-'
     * TAB target-or-'-' LF. Directories and symlinks have size 0. No escaping is needed because
     * paths and targets exclude control characters, backslash, and non-ASCII characters.
     */
    public static String computeInventorySha256(JSONArray entries) throws IOException {
        try {
            return inventoryDigest(parseInventory(entries));
        } catch (JSONException | IllegalArgumentException exception) {
            throw new IOException("Malformed inventory", exception);
        }
    }

    public JSONObject toJson() throws IOException {
        try {
            JSONObject json = new JSONObject();
            json.put("formatVersion", FORMAT_VERSION);
            json.put("id", id);
            json.put("version", version);
            json.put("abi", abi);
            json.put("dataSchema", dataSchema);
            json.put("archiveSha256", archiveSha256);
            json.put("maxUnpackedBytes", maxUnpackedBytes);
            json.put("entrypoint", entrypoint);
            json.put("nodeVersion", nodeVersion);
            json.put("dshVersion", dshVersion);
            json.put("inventorySha256", inventorySha256);
            json.put("requiredDirectories", new JSONArray(requiredDirectories));
            JSONArray entries = new JSONArray();
            for (Entry entry : files.values()) {
                JSONObject item = new JSONObject();
                item.put("path", entry.path);
                item.put("type", entry.type);
                item.put("mode", entry.mode);
                if ("file".equals(entry.type)) {
                    item.put("size", entry.size);
                    item.put("sha256", entry.sha256);
                } else if ("symlink".equals(entry.type)) {
                    item.put("target", entry.target);
                }
                entries.put(item);
            }
            json.put("files", entries);
            return json;
        } catch (JSONException exception) {
            throw new IOException("Cannot encode runtime manifest", exception);
        }
    }

    private static SortedMap<String, Entry> parseInventory(JSONArray entries)
            throws IOException, JSONException {
        require(entries != null && entries.length() > 0 && entries.length() <= MAX_ENTRIES,
                "Invalid inventory entry count");
        SortedMap<String, Entry> result = new TreeMap<>();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject item = entries.getJSONObject(i);
            String path = path(string(item, "path"));
            String type = string(item, "type");
            long rawMode = integer(item, "mode");
            require(rawMode >= 0 && rawMode <= 0777
                    && ("symlink".equals(type) || (rawMode & 0022) == 0),
                    "Unsafe permission mode: " + path);
            int mode = (int) rawMode;
            long size = 0;
            String sha = null;
            String target = null;
            if ("file".equals(type)) {
                exactKeys(item, "path", "type", "mode", "size", "sha256");
                size = integer(item, "size");
                require(size >= 0 && size <= MAX_UNPACKED_BYTES, "Invalid file size: " + path);
                require((mode & 0400) != 0, "File must be owner-readable: " + path);
                sha = digestString(string(item, "sha256"));
            } else if ("dir".equals(type)) {
                exactKeys(item, "path", "type", "mode");
                require((mode & 0500) == 0500, "Directory must be owner-readable/searchable: " + path);
            } else if ("symlink".equals(type)) {
                exactKeys(item, "path", "type", "mode", "target");
                // Linux symlink permissions are always 0777 and cannot be chmod'ed safely.
                require(rawMode == 0777, "Symlink mode must be 0777: " + path);
                target = linkTarget(string(item, "target"));
            } else {
                throw new IOException("Unsupported inventory member type: " + type);
            }
            require(result.put(path, new Entry(path, type, mode, size, sha, target)) == null,
                    "Duplicate inventory path: " + path);
        }
        for (Entry entry : result.values()) {
            String ancestor = parent(entry.path);
            while (!ancestor.isEmpty()) {
                Entry directory = result.get(ancestor);
                require(directory != null && "dir".equals(directory.type),
                        "Missing or non-directory ancestor: " + ancestor);
                ancestor = parent(ancestor);
            }
            if ("symlink".equals(entry.type)) {
                // First enforce lexical confinement, then real component-by-component symlink
                // semantics ("link/.." is not equivalent to lexical normalization).
                lexicalTarget(entry.path, entry.target);
                resolveTarget(result, entry);
            }
        }
        return result;
    }

    private static void lexicalTarget(String path, String target) throws IOException {
        int depth = parent(path).isEmpty() ? 0 : parent(path).split("/").length;
        for (String component : target.split("/", -1)) {
            if ("..".equals(component)) {
                require(depth > 0, "Symlink escapes payload: " + path);
                depth--;
            } else if (!".".equals(component)) {
                depth++;
            }
        }
    }

    private static void resolveTarget(Map<String, Entry> files, Entry link) throws IOException {
        Deque<String> pending = new ArrayDeque<>();
        if (!parent(link.path).isEmpty()) {
            Collections.addAll(pending, parent(link.path).split("/"));
        }
        Collections.addAll(pending, link.target.split("/", -1));
        List<String> resolved = new ArrayList<>();
        int links = 0;
        while (!pending.isEmpty()) {
            String component = pending.removeFirst();
            if (".".equals(component)) continue;
            if ("..".equals(component)) {
                require(!resolved.isEmpty(), "Symlink resolution escapes payload: " + link.path);
                resolved.remove(resolved.size() - 1);
                continue;
            }
            resolved.add(component);
            String name = join(resolved);
            Entry entry = files.get(name);
            require(entry != null, "Dangling symlink target: " + link.path);
            if ("symlink".equals(entry.type)) {
                require(++links <= 40, "Symlink cycle or excessive indirection: " + link.path);
                resolved.remove(resolved.size() - 1);
                String[] target = entry.target.split("/", -1);
                for (int i = target.length - 1; i >= 0; i--) pending.addFirst(target[i]);
            } else if (!pending.isEmpty()) {
                require("dir".equals(entry.type), "Symlink traverses a regular file: " + link.path);
            }
        }
    }

    private static String join(List<String> components) {
        StringBuilder text = new StringBuilder();
        for (String component : components) {
            if (text.length() > 0) text.append('/');
            text.append(component);
        }
        return text.toString();
    }

    static String parent(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? "" : path.substring(0, slash);
    }

    static String path(String value) throws IOException {
        printable(value, "path");
        // POSIX distribution metadata legitimately uses colons (libc6:arm64.list).
        // Reject drive-prefixed paths without banning ordinary relative POSIX names.
        require(value.length() <= 1024 && !value.startsWith("/") && !value.matches("^[A-Za-z]:.*"),
                "Invalid member path");
        for (String component : value.split("/", -1)) {
            require(!component.isEmpty() && !".".equals(component) && !"..".equals(component)
                    && component.length() <= 255, "Unsafe member path: " + value);
        }
        return value;
    }

    private static String linkTarget(String value) throws IOException {
        printable(value, "symlink target");
        require(value.length() <= 1024 && !value.startsWith("/") && value.indexOf(':') < 0,
                "Invalid symlink target");
        for (String component : value.split("/", -1)) {
            require(!component.isEmpty() && component.length() <= 255, "Invalid symlink target");
        }
        return value;
    }

    private static void printable(String value, String field) throws IOException {
        require(value != null && !value.isEmpty(), "Empty " + field);
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            require(character >= 33 && character <= 126 && character != '\\', "Invalid " + field);
        }
    }

    private static String token(String value, String field) throws IOException {
        require(value.matches("[A-Za-z0-9][A-Za-z0-9._+-]{0,127}"), "Invalid " + field);
        return value;
    }

    private static String exactVersion(String value) throws IOException {
        require(value.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\\+[A-Za-z0-9.-]+)?")
                && value.length() <= 128, "Exact Node/DSH version required");
        return value;
    }

    static String digestString(String value) throws IOException {
        require(value.matches("[0-9a-f]{64}"), "SHA256 must be 64 lowercase hex characters");
        return value;
    }

    private static String inventoryDigest(SortedMap<String, Entry> entries) {
        MessageDigest digest = sha256();
        digest.update("dsh-runtime-inventory-v1\n".getBytes(StandardCharsets.UTF_8));
        for (Entry entry : entries.values()) {
            String octal = Integer.toOctalString(entry.mode);
            while (octal.length() < 4) octal = "0" + octal;
            String line = entry.type + "\t" + entry.path + "\t" + octal + "\t" + entry.size
                    + "\t" + (entry.sha256 == null ? "-" : entry.sha256)
                    + "\t" + (entry.target == null ? "-" : entry.target) + "\n";
            digest.update(line.getBytes(StandardCharsets.UTF_8));
        }
        return hex(digest.digest());
    }

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            result.append("0123456789abcdef".charAt((value & 255) >>> 4));
            result.append("0123456789abcdef".charAt(value & 15));
        }
        return result.toString();
    }

    static String string(JSONObject json, String key) throws IOException, JSONException {
        Object value = json.get(key);
        require(value instanceof String, "Expected string: " + key);
        return (String) value;
    }

    static long integer(JSONObject json, String key) throws IOException, JSONException {
        Object value = json.get(key);
        require(value instanceof Integer || value instanceof Long, "Expected integer: " + key);
        return ((Number) value).longValue();
    }

    static void exactKeys(JSONObject json, String... names) throws IOException {
        require(json.length() == names.length, "Unexpected or missing JSON fields");
        for (String name : names) require(json.has(name), "Missing JSON field: " + name);
    }

    static void require(boolean condition, String message) throws IOException {
        if (!condition) throw new IOException(message);
    }
}
