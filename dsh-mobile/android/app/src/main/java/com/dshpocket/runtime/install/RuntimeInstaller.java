package com.dshpocket.runtime.install;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

import static com.dshpocket.runtime.install.RuntimeManifest.require;

/**
 * Synchronous, Android API 24+ runtime installation. No React Native, networking, or execution.
 *
 * MUTATION PRECONDITION: the caller must hold its lifecycle lock and establish that the runtime
 * is stopped before install/rollback, keeping it stopped until the call returns. The on-disk
 * lock serializes installers across processes; it cannot stop a running runtime. Runtime/data
 * roots must be private to the app, and must not contain one another. Runtime code must never
 * write its installation; all mutable state belongs in persistentDataRoot.
 *
 * Layout: releases/<UUID>/{payload/,manifest.json}, staging/<UUID>/, active.json, installer.lock.
 * Never scans for a newest release, adopts orphan releases, cleans staging, or deletes data.
 * A missing pointer means uninstalled. A malformed/corrupt pointer is an error, never a reset.
 */
public final class RuntimeInstaller {
    private static final int MAX_METADATA_BYTES = 32 * 1024 * 1024;
    private static final int MAX_POINTER_BYTES = 4096;
    private static final long ARCHIVE_TRAILER_ALLOWANCE = 1024 * 1024;
    private static final String UUID_PATTERN =
            "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

    /** Throw IOException (or terminate the test process) at a named durable boundary. */
    public interface FailureInjector {
        void checkpoint(String name) throws IOException;
    }

    private final File runtimeRoot;
    private final File persistentDataRoot;
    private final File releasesRoot;
    private final File stagingRoot;
    private final int supportedDataSchema;
    private final String abi;
    private final FailureInjector failures;

    public RuntimeInstaller(File runtimeRoot, File persistentDataRoot,
                            int supportedDataSchema, String abi) throws IOException {
        this(runtimeRoot, persistentDataRoot, supportedDataSchema, abi, name -> { });
    }

    public RuntimeInstaller(File runtimeRoot, File persistentDataRoot,
                            int supportedDataSchema, String abi, FailureInjector failures)
            throws IOException {
        require(runtimeRoot != null && persistentDataRoot != null, "Runtime and data roots required");
        require(supportedDataSchema >= 0, "Invalid supported data schema");
        require(abi != null && abi.matches("[A-Za-z0-9][A-Za-z0-9._+-]{0,127}"), "Invalid ABI");
        require(failures != null, "Failure injector required");
        // Check the supplied leaf before canonicalizing it; accepting a symlink leaf here would
        // silently turn a forbidden runtime/data root into its destination.
        rejectSymlink(runtimeRoot.getAbsoluteFile());
        rejectSymlink(persistentDataRoot.getAbsoluteFile());
        this.runtimeRoot = runtimeRoot.getCanonicalFile();
        this.persistentDataRoot = persistentDataRoot.getCanonicalFile();
        require(!contains(this.runtimeRoot, this.persistentDataRoot)
                && !contains(this.persistentDataRoot, this.runtimeRoot),
                "Runtime and persistent data paths must be completely separate");
        this.releasesRoot = new File(this.runtimeRoot, "releases");
        this.stagingRoot = new File(this.runtimeRoot, "staging");
        this.supportedDataSchema = supportedDataSchema;
        this.abi = abi;
        this.failures = failures;
    }

    /** Install only an application-pinned manifest. Caller must have stopped the runtime. */
    public JSONObject install(File artifact, RuntimeManifest trustedManifest) throws IOException {
        require(trustedManifest != null, "App-pinned manifest required");
        compatible(trustedManifest);
        require(artifact != null, "Archive required");
        byte[] metadata = trustedManifest.toJson().toString().getBytes(StandardCharsets.UTF_8);
        require(metadata.length <= MAX_METADATA_BYTES, "Manifest is too large");
        return locked(() -> {
            Pointer old = readPointer(); // Fail closed before touching a new installation.
            VerifiedState oldState = old == null ? null : validatePointer(old);
            // Reclaim abandoned staging/orphan releases before reserving space. Never adopt them.
            cleanupAbandoned(old);
            long required = artifact.length() + trustedManifest.maxUnpackedBytes + 64L * 1024 * 1024;
            if (runtimeRoot.getUsableSpace() < required) throw new IOException("RUNTIME_STORAGE");
            String directory = UUID.randomUUID().toString();
            File stage = new File(stagingRoot, directory);
            createDirectory(stage, 0700);
            File payload = new File(stage, "payload");
            createDirectory(payload, 0700);
            syncDirectory(stagingRoot);
            failures.checkpoint("staging-created");

            File snapshot = new File(stage, "artifact.tar");
            snapshotArchive(artifact, snapshot, trustedManifest);
            failures.checkpoint("archive-verified");
            extract(snapshot, payload, trustedManifest);
            failures.checkpoint("symlinks-created");
            verifyPayload(payload, trustedManifest);
            failures.checkpoint("payload-verified");
            unlink(snapshot);
            writeNew(new File(stage, "manifest.json"), metadata, 0400);
            chmod(payload, 0555);
            syncDirectory(payload);
            // Keep stage writable for the cross-parent rename, which updates its '..' entry.
            syncDirectory(stage);

            File ready = new File(releasesRoot, directory);
            require(statOrNull(ready) == null, "Release directory already exists");
            rename(stage, ready);
            chmod(ready, 0555);
            syncDirectory(ready);
            // A cross-directory rename changes both parents. Sync both before referencing ready.
            syncDirectory(releasesRoot);
            syncDirectory(stagingRoot);
            failures.checkpoint("release-ready");
            Reference active = new Reference(directory, digest(metadata));
            Pointer next = new Pointer(active, old == null ? null : old.active);
            publish(next);
            return describe(next, trustedManifest, oldState == null ? null : oldState.active);
        });
    }

    /** Read and fully verify active and last-known-good content. Safe while runtime is running. */
    public JSONObject current() throws IOException {
        return locked(() -> {
            Pointer pointer = readPointer();
            if (pointer == null) return emptyState();
            VerifiedState state = validatePointer(pointer);
            return describe(pointer, state.active, state.previous);
        });
    }

    /**
     * Cheap metadata summary for the status UI. It validates the pointer and the
     * pinned manifest digests, but does not hash the 20k+ payload files; a start
     * still goes through current() and full payload verification before launching.
     */
    public JSONObject summary() throws IOException {
        return locked(() -> {
            Pointer pointer = readPointer();
            if (pointer == null) return emptyState();
            RuntimeManifest active = readReleaseMetadata(pointer.active);
            RuntimeManifest previous = pointer.previous == null ? null : readReleaseMetadata(pointer.previous);
            return describe(pointer, active, previous);
        });
    }

    /** Atomically swap active and previous; never migrates or deletes data. Runtime must be stopped. */
    public JSONObject rollback() throws IOException {
        return locked(() -> {
            Pointer old = readPointer();
            require(old != null && old.previous != null, "No last-known-good release to roll back to");
            VerifiedState state = validatePointer(old);
            compatible(state.previous);
            Pointer next = new Pointer(old.previous, old.active);
            publish(next);
            return describe(next, state.previous, state.active);
        });
    }

    private interface Operation {
        JSONObject run() throws IOException;
    }

    private JSONObject locked(Operation operation) throws IOException {
        ensureDirectoryTree(runtimeRoot);
        ensureDirectoryTree(persistentDataRoot);
        // Recheck leaves for every operation, including when another process created them.
        directory(runtimeRoot);
        directory(persistentDataRoot);
        File lockFile = new File(runtimeRoot, "installer.lock");
        FileDescriptor descriptor = open(lockFile,
                OsConstants.O_RDWR | OsConstants.O_CREAT | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC,
                0600);
        try (FileOutputStream lockStream = new OwnedOutputStream(descriptor)) {
            require(OsConstants.S_ISREG(fstat(descriptor).st_mode), "Installer lock is not a regular file");
            try (FileLock installerLock = lockStream.getChannel().lock()) {
                require(installerLock.isValid(), "Runtime installer lock is invalid");
                ensureChildDirectory(releasesRoot);
                ensureChildDirectory(stagingRoot);
                syncDirectory(runtimeRoot);
                return operation.run();
            } catch (OverlappingFileLockException exception) {
                throw new IOException("Runtime installer is already locked in this process", exception);
            }
        }
    }

    private void compatible(RuntimeManifest manifest) throws IOException {
        require(abi.equals(manifest.abi), "Runtime ABI is incompatible");
        require(supportedDataSchema == manifest.dataSchema, "Runtime data schema is incompatible");
    }

    private static final class VerifiedState {
        final RuntimeManifest active;
        final RuntimeManifest previous;

        VerifiedState(RuntimeManifest active, RuntimeManifest previous) {
            this.active = active;
            this.previous = previous;
        }
    }

    private VerifiedState validatePointer(Pointer pointer) throws IOException {
        RuntimeManifest active = readRelease(pointer.active);
        RuntimeManifest previous = pointer.previous == null ? null : readRelease(pointer.previous);
        return new VerifiedState(active, previous);
    }

    private RuntimeManifest readRelease(Reference reference) throws IOException {
        RuntimeManifest manifest = readReleaseMetadata(reference);
        verifyPayload(new File(new File(releasesRoot, reference.directory), "payload"), manifest);
        return manifest;
    }

    private RuntimeManifest readReleaseMetadata(Reference reference) throws IOException {
        File release = new File(releasesRoot, reference.directory);
        directory(release);
        String[] children = release.list();
        require(children != null && children.length == 2, "Release directory has unexpected contents");
        Set<String> names = new HashSet<>();
        for (String name : children) names.add(name);
        require(names.contains("payload") && names.contains("manifest.json"), "Incomplete release");
        byte[] bytes = readBounded(new File(release, "manifest.json"), MAX_METADATA_BYTES);
        require(reference.manifestSha256.equals(digest(bytes)), "Stored release metadata digest mismatch");
        // This is our own persisted app-pinned metadata, authenticated by the committed pointer.
        RuntimeManifest manifest = RuntimeManifest.fromTrustedAppJson(parseLocalJson(bytes));
        compatible(manifest);
        return manifest;
    }

    private Pointer readPointer() throws IOException {
        File file = new File(runtimeRoot, "active.json");
        if (statOrNull(file) == null) return null;
        try {
            JSONObject json = parseLocalJson(readBounded(file, MAX_POINTER_BYTES));
            RuntimeManifest.exactKeys(json, "formatVersion", "active", "previous", "checksum");
            require(RuntimeManifest.integer(json, "formatVersion") == 1, "Unsupported active pointer");
            Reference active = Reference.parse(json.getJSONObject("active"));
            Reference previous = json.isNull("previous") ? null
                    : Reference.parse(json.getJSONObject("previous"));
            require(previous == null || !active.directory.equals(previous.directory),
                    "Active and previous references conflict");
            Pointer pointer = new Pointer(active, previous);
            require(pointer.checksum().equals(RuntimeManifest.string(json, "checksum")),
                    "Corrupt active pointer checksum");
            return pointer;
        } catch (JSONException exception) {
            throw new IOException("Corrupt runtime active pointer", exception);
        }
    }

    private void publish(Pointer pointer) throws IOException {
        byte[] bytes = pointer.toJson().toString().getBytes(StandardCharsets.UTF_8);
        File temporary = new File(runtimeRoot, "active.tmp-" + UUID.randomUUID());
        writeNew(temporary, bytes, 0600);
        // The old pointer remains authoritative through this checkpoint. An orphan temp is ignored.
        failures.checkpoint("pointer-synced");
        rename(temporary, new File(runtimeRoot, "active.json"));
        failures.checkpoint("pointer-renamed");
        syncDirectory(runtimeRoot);
        failures.checkpoint("activated");
    }

    private JSONObject emptyState() throws IOException {
        try {
            JSONObject result = new JSONObject();
            result.put("installed", false);
            result.put("release", JSONObject.NULL);
            result.put("path", JSONObject.NULL);
            result.put("dataSchema", JSONObject.NULL);
            result.put("dataPath", persistentDataRoot.getAbsolutePath());
            result.put("previous", JSONObject.NULL);
            return result;
        } catch (JSONException exception) {
            throw new IOException("Cannot encode runtime state", exception);
        }
    }

    private JSONObject describe(Pointer pointer, RuntimeManifest manifest, RuntimeManifest previous)
            throws IOException {
        try {
            JSONObject result = releaseDescription(pointer.active, manifest);
            result.put("installed", true);
            result.put("dataPath", persistentDataRoot.getAbsolutePath());
            result.put("previous", pointer.previous == null ? JSONObject.NULL
                    : releaseDescription(pointer.previous, previous));
            return result;
        } catch (JSONException exception) {
            throw new IOException("Cannot encode runtime state", exception);
        }
    }

    private JSONObject releaseDescription(Reference reference, RuntimeManifest manifest)
            throws JSONException {
        File payload = new File(new File(releasesRoot, reference.directory), "payload");
        JSONObject result = new JSONObject();
        result.put("release", reference.directory);
        result.put("id", manifest.id);
        result.put("version", manifest.version);
        result.put("abi", manifest.abi);
        result.put("dataSchema", manifest.dataSchema);
        result.put("path", payload.getAbsolutePath());
        result.put("entrypoint", new File(payload, manifest.entrypoint).getAbsolutePath());
        result.put("entrypointRelative", manifest.entrypoint);
        result.put("nodeVersion", manifest.nodeVersion);
        result.put("dshVersion", manifest.dshVersion);
        result.put("archiveSha256", manifest.archiveSha256);
        result.put("inventorySha256", manifest.inventorySha256);
        return result;
    }

    private static final class Reference {
        final String directory;
        final String manifestSha256;

        Reference(String directory, String manifestSha256) {
            this.directory = directory;
            this.manifestSha256 = manifestSha256;
        }

        static Reference parse(JSONObject json) throws IOException, JSONException {
            RuntimeManifest.exactKeys(json, "directory", "manifestSha256");
            String directory = RuntimeManifest.string(json, "directory");
            require(directory.matches(UUID_PATTERN), "Unsafe release reference");
            return new Reference(directory,
                    RuntimeManifest.digestString(RuntimeManifest.string(json, "manifestSha256")));
        }

        JSONObject toJson() throws JSONException {
            JSONObject json = new JSONObject();
            json.put("directory", directory);
            json.put("manifestSha256", manifestSha256);
            return json;
        }
    }

    private static final class Pointer {
        final Reference active;
        final Reference previous;

        Pointer(Reference active, Reference previous) {
            this.active = active;
            this.previous = previous;
        }

        String checksum() {
            String text = "dsh-runtime-pointer-v1\n" + active.directory + "\t"
                    + active.manifestSha256 + "\n" + (previous == null ? "-\t-\n"
                    : previous.directory + "\t" + previous.manifestSha256 + "\n");
            return digest(text.getBytes(StandardCharsets.UTF_8));
        }

        JSONObject toJson() throws IOException {
            try {
                JSONObject json = new JSONObject();
                json.put("formatVersion", 1);
                json.put("active", active.toJson());
                json.put("previous", previous == null ? JSONObject.NULL : previous.toJson());
                json.put("checksum", checksum());
                return json;
            } catch (JSONException exception) {
                throw new IOException("Cannot encode active pointer", exception);
            }
        }
    }

    private static void snapshotArchive(File artifact, File snapshot, RuntimeManifest manifest)
            throws IOException {
        long limit = manifest.maxUnpackedBytes + manifest.files.size() * 1024L
                + ARCHIVE_TRAILER_ALLOWANCE;
        MessageDigest digest = RuntimeManifest.sha256();
        try (FileInputStream input = readRegular(artifact);
             FileOutputStream output = createNew(snapshot, 0600)) {
            long total = 0;
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                require(count <= limit - total, "Archive exceeds bounded size");
                total += count;
                digest.update(buffer, 0, count);
                output.write(buffer, 0, count);
            }
            require(total >= 1024 && total % 512 == 0, "Archive is not a complete uncompressed tar");
            require(manifest.archiveSha256.equals(RuntimeManifest.hex(digest.digest())),
                    "Pinned archive SHA256 mismatch");
            output.getFD().sync();
        }
    }

    private void extract(File archive, File payload, RuntimeManifest manifest) throws IOException {
        // Precreate only trusted, explicitly inventoried directories. Archive order is irrelevant.
        for (RuntimeManifest.Entry entry : manifest.files.values()) {
            if ("dir".equals(entry.type)) {
                checkAncestors(payload, entry.path);
                createDirectory(new File(payload, entry.path), 0700);
            }
        }
        Set<String> seen = new HashSet<>();
        long unpacked = 0;
        try (FileInputStream input = readRegular(archive)) {
            byte[] header = new byte[512];
            while (true) {
                readFully(input, header, 0, header.length);
                if (zero(header)) {
                    readFully(input, header, 0, header.length);
                    require(zero(header), "Tar must end with two zero blocks");
                    int count;
                    while ((count = input.read(header)) != -1) {
                        for (int i = 0; i < count; i++) require(header[i] == 0, "Nonzero tar trailer");
                    }
                    break;
                }
                TarMember member = TarMember.parse(header);
                require(seen.size() < manifest.files.size() && seen.add(member.path),
                        "Duplicate or excessive tar members");
                RuntimeManifest.Entry expected = manifest.files.get(member.path);
                require(expected != null, "Archive member is absent from trusted inventory: " + member.path);
                require(expected.type.equals(member.type) && expected.mode == member.mode
                        && expected.size == member.size
                        && (expected.target == null ? member.target.isEmpty()
                        : expected.target.equals(member.target)),
                        "Archive member metadata mismatch: " + member.path);
                require(member.size <= manifest.maxUnpackedBytes - unpacked,
                        "Archive exceeds unpacked byte limit");
                unpacked += member.size;
                checkAncestors(payload, member.path);
                if ("file".equals(member.type)) {
                    File destination = new File(payload, member.path);
                    MessageDigest digest = RuntimeManifest.sha256();
                    try (FileOutputStream output = createNew(destination, 0600)) {
                        byte[] buffer = new byte[64 * 1024];
                        long remaining = member.size;
                        while (remaining > 0) {
                            int count = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                            require(count > 0, "Truncated tar payload");
                            remaining -= count;
                            digest.update(buffer, 0, count);
                            output.write(buffer, 0, count);
                        }
                        require(expected.sha256.equals(RuntimeManifest.hex(digest.digest())),
                                "File digest mismatch: " + member.path);
                        chmod(destination, member.mode);
                        output.getFD().sync();
                    }
                    int padding = (int) ((512 - member.size % 512) % 512);
                    for (int i = 0; i < padding; i++) require(input.read() == 0, "Invalid tar file padding");
                }
                // Symlinks are deliberately deferred until all regular file output streams close.
                failures.checkpoint("entry-extracted:" + member.path);
            }
        }
        require(seen.size() == manifest.files.size(), "Archive is missing inventory members");
        for (RuntimeManifest.Entry entry : manifest.files.values()) {
            if ("symlink".equals(entry.type)) {
                checkAncestors(payload, entry.path);
                File link = new File(payload, entry.path);
                require(statOrNull(link) == null, "Symlink destination already exists");
                try {
                    Os.symlink(entry.target, link.getAbsolutePath());
                } catch (ErrnoException exception) {
                    throw io("Create runtime symlink", exception);
                }
            }
        }
        // Apply directory modes last, since trusted directories may be read-only.
        for (RuntimeManifest.Entry entry : manifest.files.values()) {
            if ("dir".equals(entry.type)) chmod(new File(payload, entry.path), entry.mode);
        }
        syncTreeDirectories(payload, manifest);
    }

    private static final class TarMember {
        String path;
        String type;
        int mode;
        long size;
        String target;

        static TarMember parse(byte[] header) throws IOException {
            require(header[257] == 'u' && header[258] == 's' && header[259] == 't'
                    && header[260] == 'a' && header[261] == 'r' && header[262] == 0
                    && header[263] == '0' && header[264] == '0', "Only POSIX USTAR is supported");
            long checksum = 0;
            for (int i = 0; i < header.length; i++) {
                checksum += i >= 148 && i < 156 ? 32 : header[i] & 255;
            }
            require(checksum == octal(header, 148, 8), "Invalid tar header checksum");
            for (int i = 500; i < 512; i++) require(header[i] == 0, "Nonzero USTAR reserved bytes");
            TarMember member = new TarMember();
            String name = text(header, 0, 100);
            String prefix = text(header, 345, 155);
            member.path = prefix.isEmpty() ? name : prefix + "/" + name;
            int type = header[156] & 255;
            if (type == '0' || type == 0) member.type = "file";
            else if (type == '5') member.type = "dir";
            else if (type == '2') member.type = "symlink";
            else throw new IOException("Forbidden tar member type (hardlink/device/PAX/etc.): " + type);
            if ("dir".equals(member.type) && member.path.endsWith("/")) {
                member.path = member.path.substring(0, member.path.length() - 1);
            }
            member.path = RuntimeManifest.path(member.path);
            long mode = octal(header, 100, 8);
            require(mode <= 0777, "Special tar permissions are forbidden");
            member.mode = (int) mode;
            member.size = octal(header, 124, 12);
            member.target = text(header, 157, 100);
            require("file".equals(member.type) || member.size == 0, "Non-file tar member has data");
            require("symlink".equals(member.type) || member.target.isEmpty(), "Unexpected tar link target");
            octal(header, 108, 8); // uid/gid/mtime are parsed but never applied.
            octal(header, 116, 8);
            octal(header, 136, 12);
            require(octal(header, 329, 8) == 0 && octal(header, 337, 8) == 0,
                    "Device metadata is forbidden");
            return member;
        }

        private static long octal(byte[] bytes, int start, int length) throws IOException {
            int end = start + length;
            int index = start;
            while (index < end && bytes[index] == ' ') index++;
            long value = 0;
            boolean ended = false;
            for (; index < end; index++) {
                int character = bytes[index] & 255;
                if (character == 0 || character == ' ') ended = true;
                else {
                    require(!ended && character >= '0' && character <= '7', "Invalid USTAR octal number");
                    require(value <= (Long.MAX_VALUE - 7) / 8, "USTAR numeric overflow");
                    value = value * 8 + character - '0';
                }
            }
            return value;
        }

        private static String text(byte[] bytes, int start, int length) throws IOException {
            int end = start;
            while (end < start + length && bytes[end] != 0) {
                require((bytes[end] & 255) >= 32 && (bytes[end] & 255) <= 126,
                        "Non-ASCII USTAR name");
                end++;
            }
            for (int i = end; i < start + length; i++) require(bytes[i] == 0, "Invalid USTAR string padding");
            return new String(bytes, start, end - start, StandardCharsets.US_ASCII);
        }
    }

    private static void verifyPayload(File payload, RuntimeManifest manifest) throws IOException {
        directory(payload);
        Set<String> seen = new HashSet<>();
        verifyDirectory(payload, "", manifest, seen);
        require(seen.size() == manifest.files.size(), "Installed runtime inventory is incomplete");
        for (String path : manifest.requiredDirectories) directory(new File(payload, path));
        RuntimeManifest.Entry entrypoint = manifest.files.get(manifest.entrypoint);
        require(entrypoint != null && (entrypoint.mode & 0100) != 0,
                "Required executable entrypoint is missing");
    }

    private static void verifyDirectory(File payload, String relative, RuntimeManifest manifest,
                                        Set<String> seen) throws IOException {
        File folder = relative.isEmpty() ? payload : new File(payload, relative);
        String[] names = folder.list();
        require(names != null, "Cannot enumerate installed runtime");
        for (String name : names) {
            String path = relative.isEmpty() ? name : relative + "/" + name;
            RuntimeManifest.Entry entry = manifest.files.get(path);
            require(entry != null && seen.add(path) && seen.size() <= manifest.files.size(),
                    "Unexpected installed runtime member: " + path);
            File file = new File(payload, path);
            StructStat stat = statOrNull(file);
            require(stat != null && (stat.st_mode & 07777) == entry.mode,
                    "Installed runtime mode mismatch: " + path);
            if ("dir".equals(entry.type)) {
                require(OsConstants.S_ISDIR(stat.st_mode), "Installed runtime directory mismatch: " + path);
                verifyDirectory(payload, path, manifest, seen);
            } else if ("file".equals(entry.type)) {
                require(OsConstants.S_ISREG(stat.st_mode) && stat.st_nlink == 1 && stat.st_size == entry.size,
                        "Installed regular file mismatch: " + path);
                require(entry.sha256.equals(digestFile(file, entry.size)),
                        "Installed runtime file digest mismatch: " + path);
            } else {
                require(OsConstants.S_ISLNK(stat.st_mode), "Installed symlink mismatch: " + path);
                try {
                    require(entry.target.equals(Os.readlink(file.getAbsolutePath())),
                            "Installed symlink target mismatch: " + path);
                } catch (ErrnoException exception) {
                    throw io("Read runtime symlink", exception);
                }
            }
        }
    }

    private static void checkAncestors(File payload, String member) throws IOException {
        directory(payload);
        String parent = RuntimeManifest.parent(member);
        while (!parent.isEmpty()) {
            directory(new File(payload, parent));
            parent = RuntimeManifest.parent(parent);
        }
    }

    private static void syncTreeDirectories(File payload, RuntimeManifest manifest) throws IOException {
        // Reverse path order puts descendants before ancestors.
        for (RuntimeManifest.Entry entry : new java.util.TreeMap<>(manifest.files).descendingMap().values()) {
            if ("dir".equals(entry.type)) syncDirectory(new File(payload, entry.path));
        }
        syncDirectory(payload);
    }

    private static void ensureDirectoryTree(File file) throws IOException {
        StructStat stat = statOrNull(file);
        if (stat != null) {
            require(OsConstants.S_ISDIR(stat.st_mode), "Root path is not a real directory: " + file);
            return;
        }
        File parent = file.getParentFile();
        require(parent != null, "Cannot create filesystem root");
        ensureDirectoryTree(parent);
        try {
            Os.mkdir(file.getAbsolutePath(), 0700);
        } catch (ErrnoException exception) {
            if (exception.errno != OsConstants.EEXIST) throw io("Create private runtime directory", exception);
        }
        directory(file);
        syncDirectory(parent);
    }

    private static void ensureChildDirectory(File file) throws IOException {
        if (statOrNull(file) == null) createDirectory(file, 0700);
        else directory(file);
    }

    private static void createDirectory(File file, int mode) throws IOException {
        try {
            Os.mkdir(file.getAbsolutePath(), mode);
            chmod(file, mode); // Do not depend on process umask.
        } catch (ErrnoException exception) {
            throw io("Create fresh runtime directory", exception);
        }
        directory(file);
    }

    private static void directory(File file) throws IOException {
        StructStat stat = statOrNull(file);
        require(stat != null && OsConstants.S_ISDIR(stat.st_mode),
                "Expected a real directory, not a symlink: " + file);
    }

    private static void rejectSymlink(File file) throws IOException {
        StructStat stat = statOrNull(file);
        require(stat == null || !OsConstants.S_ISLNK(stat.st_mode), "Root cannot be a symlink: " + file);
    }

    private static boolean contains(File parent, File child) {
        return child.equals(parent) || child.getPath().startsWith(parent.getPath() + File.separator);
    }

    private static StructStat statOrNull(File file) throws IOException {
        try {
            return Os.lstat(file.getAbsolutePath());
        } catch (ErrnoException exception) {
            if (exception.errno == OsConstants.ENOENT) return null;
            throw io("Inspect runtime path", exception);
        }
    }

    private static StructStat fstat(FileDescriptor descriptor) throws IOException {
        try {
            return Os.fstat(descriptor);
        } catch (ErrnoException exception) {
            throw io("Inspect runtime file descriptor", exception);
        }
    }

    private static FileDescriptor open(File file, int flags, int mode) throws IOException {
        try {
            return Os.open(file.getAbsolutePath(), flags, mode);
        } catch (ErrnoException exception) {
            throw io("Open runtime file", exception);
        }
    }

    // Android streams constructed from an existing descriptor may not own it. Always close the
    // descriptor we opened, including on libcore versions where stream.close() leaves it valid.
    private static final class OwnedInputStream extends FileInputStream {
        private final FileDescriptor owned;
        private boolean closed;

        OwnedInputStream(FileDescriptor descriptor) {
            super(descriptor);
            owned = descriptor;
        }

        @Override public void close() throws IOException {
            if (closed) return;
            closed = true;
            try {
                super.close();
            } finally {
                closeOwned(owned);
            }
        }
    }

    private static final class OwnedOutputStream extends FileOutputStream {
        private final FileDescriptor owned;
        private boolean closed;

        OwnedOutputStream(FileDescriptor descriptor) {
            super(descriptor);
            owned = descriptor;
        }

        @Override public void close() throws IOException {
            if (closed) return;
            closed = true;
            try {
                super.close();
            } finally {
                closeOwned(owned);
            }
        }
    }

    private static void closeOwned(FileDescriptor descriptor) throws IOException {
        if (!descriptor.valid()) return;
        try {
            Os.close(descriptor);
        } catch (ErrnoException exception) {
            throw io("Close owned runtime descriptor", exception);
        }
    }

    private static FileInputStream readRegular(File file) throws IOException {
        FileDescriptor descriptor = open(file,
                OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC | OsConstants.O_NONBLOCK, 0);
        FileInputStream stream = new OwnedInputStream(descriptor);
        try {
            require(OsConstants.S_ISREG(fstat(descriptor).st_mode), "Expected regular runtime file: " + file);
            return stream;
        } catch (IOException exception) {
            stream.close();
            throw exception;
        }
    }

    private static FileOutputStream createNew(File file, int mode) throws IOException {
        FileDescriptor descriptor = open(file,
                OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL
                        | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, mode);
        FileOutputStream stream = new OwnedOutputStream(descriptor);
        try {
            require(OsConstants.S_ISREG(fstat(descriptor).st_mode), "Expected new regular runtime file");
            return stream;
        } catch (IOException exception) {
            stream.close();
            throw exception;
        }
    }

    private static void writeNew(File file, byte[] bytes, int mode) throws IOException {
        try (FileOutputStream stream = createNew(file, mode)) {
            stream.write(bytes);
            chmod(file, mode);
            stream.getFD().sync();
        }
    }

    private static byte[] readBounded(File file, int limit) throws IOException {
        try (FileInputStream stream = readRegular(file)) {
            require(fstat(stream.getFD()).st_size <= limit, "Runtime metadata exceeds size bound");
            ByteArrayOutputStream result = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                require(count <= limit - result.size(), "Runtime metadata exceeds size bound");
                result.write(buffer, 0, count);
            }
            return result.toByteArray();
        }
    }

    private static JSONObject parseLocalJson(byte[] bytes) throws IOException {
        try {
            String text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
            JSONTokener tokener = new JSONTokener(text);
            Object parsed = tokener.nextValue();
            require(parsed instanceof JSONObject && tokener.nextClean() == 0, "Invalid local runtime JSON");
            JSONObject json = (JSONObject) parsed;
            // Only our own compact serialization is stored. Requiring its exact round trip also
            // rejects duplicate keys, comments, noncanonical numbers, and trailing garbage.
            require(text.equals(json.toString()), "Corrupt or noncanonical local runtime JSON");
            return json;
        } catch (JSONException | CharacterCodingException exception) {
            throw new IOException("Corrupt local runtime JSON", exception);
        }
    }

    private static String digestFile(File file, long expectedSize) throws IOException {
        MessageDigest digest = RuntimeManifest.sha256();
        try (FileInputStream stream = readRegular(file)) {
            long remaining = expectedSize;
            byte[] buffer = new byte[64 * 1024];
            while (remaining > 0) {
                int count = stream.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                require(count > 0, "Installed file was truncated");
                remaining -= count;
                digest.update(buffer, 0, count);
            }
            require(stream.read() == -1, "Installed file grew beyond inventory size");
        }
        return RuntimeManifest.hex(digest.digest());
    }

    private static String digest(byte[] bytes) {
        return RuntimeManifest.hex(RuntimeManifest.sha256().digest(bytes));
    }

    private static void readFully(InputStream stream, byte[] bytes, int offset, int count) throws IOException {
        int remaining = count;
        while (remaining > 0) {
            int read = stream.read(bytes, offset + count - remaining, remaining);
            require(read > 0, "Truncated USTAR archive");
            remaining -= read;
        }
    }

    private static boolean zero(byte[] bytes) {
        for (byte value : bytes) if (value != 0) return false;
        return true;
    }

    private static void chmod(File file, int mode) throws IOException {
        try {
            Os.chmod(file.getAbsolutePath(), mode);
        } catch (ErrnoException exception) {
            throw io("Set runtime permissions", exception);
        }
    }

    private static void syncDirectory(File file) throws IOException {
        FileDescriptor descriptor = open(file,
                OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0);
        try {
            require(OsConstants.S_ISDIR(fstat(descriptor).st_mode), "Cannot sync a non-directory");
            Os.fsync(descriptor);
        } catch (ErrnoException exception) {
            throw io("Sync runtime directory", exception);
        } finally {
            try {
                Os.close(descriptor);
            } catch (ErrnoException exception) {
                throw io("Close runtime directory", exception);
            }
        }
    }

    private static void rename(File from, File to) throws IOException {
        try {
            Os.rename(from.getAbsolutePath(), to.getAbsolutePath());
        } catch (ErrnoException exception) {
            throw io("Atomically publish runtime state", exception);
        }
    }

    /** Delete staging and unreferenced releases. Active and previous stay intact. */
    private void cleanupAbandoned(Pointer pointer) throws IOException {
        Set<String> keep = new HashSet<>();
        if (pointer != null) {
            keep.add(pointer.active.directory);
            if (pointer.previous != null) keep.add(pointer.previous.directory);
        }
        File[] staging = stagingRoot.listFiles();
        if (staging != null) for (File entry : staging) deleteOwnedTree(entry);
        File[] releases = releasesRoot.listFiles();
        if (releases != null) for (File entry : releases) {
            if (!keep.contains(entry.getName())) deleteOwnedTree(entry);
        }
        syncDirectory(stagingRoot);
        syncDirectory(releasesRoot);
    }

    /** Never follows a symlink: lstat decides file/dir/symlink before removal. */
    private static void deleteOwnedTree(File file) throws IOException {
        StructStat stat;
        try {
            stat = Os.lstat(file.getAbsolutePath());
        } catch (ErrnoException exception) {
            if (exception.errno == OsConstants.ENOENT) return;
            throw new IOException("RUNTIME_CLEANUP", exception);
        }
        if (OsConstants.S_ISDIR(stat.st_mode)) {
            chmod(file, 0700);
            File[] children = file.listFiles();
            if (children == null) throw new IOException("RUNTIME_CLEANUP");
            for (File child : children) deleteOwnedTree(child);
            unlink(file);
        } else {
            unlink(file);
        }
    }

    private static void unlink(File file) throws IOException {
        try {
            Os.remove(file.getAbsolutePath());
        } catch (ErrnoException exception) {
            throw io("Remove private archive snapshot", exception);
        }
    }

    private static IOException io(String action, ErrnoException exception) {
        return new IOException(action + ": " + exception.getMessage(), exception);
    }
}
