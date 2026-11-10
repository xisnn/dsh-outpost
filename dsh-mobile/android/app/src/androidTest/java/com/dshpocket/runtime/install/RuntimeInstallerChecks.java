package com.dshpocket.runtime.install;

import android.system.ErrnoException;
import android.system.Os;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Optional device-only test helper with no JUnit/RN dependency. Never called by the installer.
 * Invoke run(context.getCacheDir()) on a worker thread in an isolated native test application.
 * It only creates fixtures under a fresh UUID child, never executes them, and leaves evidence
 * there for inspection. These tiny manifests are pinned by this test's own fixture generator;
 * generating a hash from an actual downloaded archive is not a production trust mechanism.
 */
public final class RuntimeInstallerChecks {
    private static final String ABI = "arm64-v8a";

    private RuntimeInstallerChecks() { }

    public static JSONObject run(File writableParent) throws IOException {
        try {
            return runChecks(writableParent);
        } catch (JSONException exception) {
            throw new IOException("Installer test fixture JSON error", exception);
        }
    }

    private static JSONObject runChecks(File parent) throws IOException, JSONException {
        File evidence = new File(parent, "runtime-installer-checks-" + UUID.randomUUID());
        check(evidence.mkdir(), "Cannot create fresh installer test directory");
        JSONArray passed = new JSONArray();
        Fixture a = fixture(evidence, "a", "0.0.1");
        Fixture b = fixture(evidence, "b", "0.0.2");
        File runtime = new File(evidence, "happy-runtime");
        File data = new File(evidence, "happy-data");
        RuntimeInstaller happy = installer(runtime, data);
        check(!happy.current().getBoolean("installed"), "Fresh runtime must be uninstalled");
        write(new File(data, "sentinel"), "preserve-data".getBytes(StandardCharsets.UTF_8));
        JSONObject first = happy.install(a.archive, a.manifest());
        check(first.getString("version").equals("0.0.1"), "First install failed");
        check(new File(first.getString("entrypoint")).canExecute(), "Executable mode was not preserved");
        try {
            check("bin/node".equals(Os.readlink(new File(first.getString("path"), "node-link")
                    .getAbsolutePath())), "Relative symlink target was not preserved");
        } catch (ErrnoException exception) {
            throw new IOException(exception);
        }
        JSONObject second = happy.install(b.archive, b.manifest());
        check(second.getJSONObject("previous").getString("release").equals(first.getString("release")),
                "Last-known-good release was not retained");
        check(happy.rollback().getString("release").equals(first.getString("release")), "Rollback failed");
        check(new File(second.getString("path")).isDirectory(), "Rollback deleted newer runtime");
        check("preserve-data".equals(new String(read(new File(data, "sentinel")), StandardCharsets.UTF_8)),
                "Installer modified persistent data");
        passed.put("install-executable-symlink-retention-rollback-data");

        JSONObject wrongSchema = copy(b.json);
        wrongSchema.put("dataSchema", 2);
        expectFailure(() -> happy.install(b.archive, RuntimeManifest.fromTrustedAppJson(wrongSchema)));
        RuntimeInstaller schemaTwo = new RuntimeInstaller(runtime, data, 2, ABI);
        expectFailure(schemaTwo::rollback);
        expectFailure(schemaTwo::current);
        JSONObject wrongAbi = copy(b.json);
        wrongAbi.put("abi", "x86_64");
        expectFailure(() -> happy.install(b.archive, RuntimeManifest.fromTrustedAppJson(wrongAbi)));
        check(happy.current().getString("release").equals(first.getString("release")),
                "Incompatible install changed active release");
        passed.put("install-current-rollback-schema-and-abi-gates");

        JSONObject wrongHash = copy(b.json);
        wrongHash.put("archiveSha256", repeat('0', 64));
        expectFailure(() -> happy.install(b.archive, RuntimeManifest.fromTrustedAppJson(wrongHash)));
        JSONObject wrongInventory = copy(b.json);
        wrongInventory.put("inventorySha256", repeat('0', 64));
        expectFailure(() -> RuntimeManifest.fromTrustedAppJson(wrongInventory));
        JSONObject wrongContent = copy(b.json);
        JSONArray changedFiles = wrongContent.getJSONArray("files");
        for (int i = 0; i < changedFiles.length(); i++) {
            JSONObject member = changedFiles.getJSONObject(i);
            if (member.getString("path").equals("bin/node")) member.put("sha256", repeat('0', 64));
        }
        wrongContent.put("inventorySha256", RuntimeManifest.computeInventorySha256(changedFiles));
        expectFailure(() -> happy.install(b.archive, RuntimeManifest.fromTrustedAppJson(wrongContent)));
        check(happy.current().getString("release").equals(first.getString("release")),
                "Failed integrity verification changed active release");
        passed.put("archive-inventory-and-content-hash-pins");

        String[] checkpoints = {"staging-created", "archive-verified", "entry-extracted:bin/node",
                "symlinks-created", "payload-verified", "release-ready", "pointer-synced",
                "pointer-renamed", "activated"};
        for (int i = 0; i < checkpoints.length; i++) {
            File crashRuntime = new File(evidence, "crash-runtime-" + i);
            File crashData = new File(evidence, "crash-data-" + i);
            RuntimeInstaller normal = installer(crashRuntime, crashData);
            normal.install(a.archive, a.manifest());
            String checkpoint = checkpoints[i];
            RuntimeInstaller injected = new RuntimeInstaller(crashRuntime, crashData, 1, ABI, name -> {
                if (name.equals(checkpoint)) throw new IOException("Injected failure: " + name);
            });
            expectFailure(() -> injected.install(b.archive, b.manifest()));
            String expected = i >= checkpoints.length - 2 ? "0.0.2" : "0.0.1";
            check(installer(crashRuntime, crashData).current().getString("version").equals(expected),
                    "Interrupted activation exposed wrong/incomplete release at " + checkpoint);
            passed.put("interruption-" + checkpoint);
        }
        String[] rollbackCheckpoints = {"pointer-synced", "pointer-renamed", "activated"};
        for (int i = 0; i < rollbackCheckpoints.length; i++) {
            File rollbackRuntime = new File(evidence, "rollback-runtime-" + i);
            File rollbackData = new File(evidence, "rollback-data-" + i);
            RuntimeInstaller normal = installer(rollbackRuntime, rollbackData);
            normal.install(a.archive, a.manifest());
            normal.install(b.archive, b.manifest());
            String checkpoint = rollbackCheckpoints[i];
            RuntimeInstaller injected = new RuntimeInstaller(rollbackRuntime, rollbackData, 1, ABI, name -> {
                if (name.equals(checkpoint)) throw new IOException("Injected rollback failure: " + name);
            });
            expectFailure(injected::rollback);
            check(installer(rollbackRuntime, rollbackData).current().getString("version")
                    .equals(i == 0 ? "0.0.2" : "0.0.1"),
                    "Interrupted rollback exposed wrong/incomplete release at " + checkpoint);
            passed.put("rollback-interruption-" + checkpoint);
        }
        File orphanRuntime = new File(evidence, "orphan-runtime");
        File orphanData = new File(evidence, "orphan-data");
        RuntimeInstaller orphan = new RuntimeInstaller(orphanRuntime, orphanData, 1, ABI, name -> {
            if (name.equals("release-ready")) throw new IOException("Injected orphan-ready failure");
        });
        expectFailure(() -> orphan.install(a.archive, a.manifest()));
        check(!installer(orphanRuntime, orphanData).current().getBoolean("installed"),
                "Orphan ready directory was autoactivated");
        passed.put("orphan-ready-never-autoactivates");

        String[] badPaths = {"../escape", "/escape", "bin/../../escape", "bin\\escape", "C:/escape", "C:escape"};
        for (int i = 0; i < badPaths.length; i++) {
            List<Member> members = members("0.0.2");
            members.set(1, new Member(badPaths[i], '0', 0755, bytes("node 0.0.2"), ""));
            Fixture bad = altered(evidence, "bad-path-" + i, b, members);
            expectFailure(() -> happy.install(bad.archive, bad.manifest()));
        }
        List<Member> duplicate = members("0.0.2");
        duplicate.add(duplicate.get(1));
        Fixture duplicateFixture = altered(evidence, "duplicate", b, duplicate);
        expectFailure(() -> happy.install(duplicateFixture.archive, duplicateFixture.manifest()));
        for (char type : new char[]{'1', '3', '4', '6', 'x', 'g', 'L'}) {
            List<Member> members = members("0.0.2");
            members.set(1, new Member("bin/node", type, 0755, new byte[0], "bin/node"));
            Fixture bad = altered(evidence, "bad-type-" + type, b, members);
            expectFailure(() -> happy.install(bad.archive, bad.manifest()));
        }
        check(!new File(evidence, "escape").exists(), "Traversal created an escaped file");
        passed.put("traversal-absolute-backslash-duplicate-hardlink-device-pax-rejected");

        for (String target : new String[]{"../escape", "/escape", "node-link", "bin/node/.."}) {
            JSONObject badLink = copy(b.json);
            JSONArray files = badLink.getJSONArray("files");
            for (int i = 0; i < files.length(); i++) {
                if (files.getJSONObject(i).getString("path").equals("node-link")) {
                    files.getJSONObject(i).put("target", target);
                }
            }
            expectFailure(() -> RuntimeManifest.computeInventorySha256(files));
        }
        JSONObject symlinkAncestor = copy(b.json);
        JSONArray ancestorFiles = symlinkAncestor.getJSONArray("files");
        JSONObject child = new JSONObject();
        child.put("path", "node-link/child");
        child.put("type", "file");
        child.put("mode", 0644);
        child.put("size", 0);
        child.put("sha256", sha(new byte[0]));
        ancestorFiles.put(child);
        expectFailure(() -> RuntimeManifest.computeInventorySha256(ancestorFiles));
        expectFailure(() -> new RuntimeInstaller(new File(evidence, "nested"),
                new File(evidence, "nested/data"), 1, ABI));
        File rootLink = new File(evidence, "root-link");
        try {
            Os.symlink(runtime.getAbsolutePath(), rootLink.getAbsolutePath());
        } catch (ErrnoException exception) {
            throw new IOException(exception);
        }
        expectFailure(() -> installer(rootLink, new File(evidence, "root-link-data")));
        passed.put("symlink-confinement-ancestors-root-and-data-separation");

        File corruptRuntime = new File(evidence, "corrupt-runtime");
        RuntimeInstaller corrupt = installer(corruptRuntime, new File(evidence, "corrupt-data"));
        corrupt.install(a.archive, a.manifest());
        corrupt.install(b.archive, b.manifest());
        File pointer = new File(corruptRuntime, "active.json");
        JSONObject pointerJson = new JSONObject(new String(read(pointer), StandardCharsets.UTF_8));
        pointerJson.put("checksum", repeat('0', 64));
        write(pointer, bytes(pointerJson.toString()));
        expectFailure(corrupt::current);
        expectFailure(corrupt::rollback);
        expectFailure(() -> corrupt.install(a.archive, a.manifest()));
        write(pointer, bytes("{broken"));
        expectFailure(corrupt::current);
        expectFailure(() -> corrupt.install(a.archive, a.manifest()));
        passed.put("corrupt-pointer-checksum-and-json-fail-closed");

        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("checks", passed);
        result.put("count", passed.length());
        result.put("evidencePath", evidence.getAbsolutePath());
        return result;
    }

    private static RuntimeInstaller installer(File runtime, File data) throws IOException {
        return new RuntimeInstaller(runtime, data, 1, ABI);
    }

    private interface CheckedAction {
        void run() throws IOException;
    }

    private static void expectFailure(CheckedAction action) throws IOException {
        try {
            action.run();
        } catch (IOException expected) {
            return;
        }
        throw new IOException("Installer test expected a refusal/failure but operation succeeded");
    }

    private static void check(boolean condition, String message) throws IOException {
        if (!condition) throw new IOException("Installer check failed: " + message);
    }

    private static final class Fixture {
        final File archive;
        final JSONObject json;

        Fixture(File archive, JSONObject json) {
            this.archive = archive;
            this.json = json;
        }

        RuntimeManifest manifest() throws IOException {
            return RuntimeManifest.fromTrustedAppJson(json);
        }
    }

    private static Fixture fixture(File folder, String name, String version)
            throws IOException, JSONException {
        List<Member> members = members(version);
        byte[] tar = tar(members);
        File archive = new File(folder, name + ".tar");
        write(archive, tar);
        JSONArray inventory = new JSONArray();
        for (Member member : members) {
            JSONObject item = new JSONObject();
            item.put("path", member.path);
            item.put("type", member.type == '0' ? "file" : member.type == '5' ? "dir" : "symlink");
            item.put("mode", member.mode);
            if (member.type == '0') {
                item.put("size", member.content.length);
                item.put("sha256", sha(member.content));
            } else if (member.type == '2') item.put("target", member.target);
            inventory.put(item);
        }
        JSONObject manifest = new JSONObject();
        manifest.put("formatVersion", 1);
        manifest.put("id", "installer-check-fixture");
        manifest.put("version", version);
        manifest.put("abi", ABI);
        manifest.put("dataSchema", 1);
        manifest.put("archiveSha256", sha(tar));
        manifest.put("maxUnpackedBytes", 4096);
        manifest.put("entrypoint", "bin/node");
        manifest.put("nodeVersion", "24.22.1");
        manifest.put("dshVersion", "0.2.2-rc.1");
        manifest.put("requiredDirectories", new JSONArray().put("bin").put("share"));
        manifest.put("inventorySha256", RuntimeManifest.computeInventorySha256(inventory));
        manifest.put("files", inventory);
        return new Fixture(archive, manifest);
    }

    private static Fixture altered(File folder, String name, Fixture base, List<Member> members)
            throws IOException, JSONException {
        byte[] tar = tar(members);
        File archive = new File(folder, name + ".tar");
        write(archive, tar);
        JSONObject manifest = copy(base.json);
        manifest.put("archiveSha256", sha(tar));
        return new Fixture(archive, manifest);
    }

    private static List<Member> members(String version) {
        List<Member> members = new ArrayList<>();
        members.add(new Member("bin", '5', 0755, new byte[0], ""));
        members.add(new Member("bin/node", '0', 0755, bytes("node " + version), ""));
        members.add(new Member("share", '5', 0755, new byte[0], ""));
        members.add(new Member("share/dsh.js", '0', 0644, bytes("fixture " + version), ""));
        members.add(new Member("share/libc6:arm64.list", '0', 0644, bytes("POSIX package metadata"), ""));
        members.add(new Member("node-link", '2', 0777, new byte[0], "bin/node"));
        return members;
    }

    private static final class Member {
        final String path;
        final char type;
        final int mode;
        final byte[] content;
        final String target;

        Member(String path, char type, int mode, byte[] content, String target) {
            this.path = path;
            this.type = type;
            this.mode = mode;
            this.content = content;
            this.target = target;
        }
    }

    private static byte[] tar(List<Member> members) throws IOException {
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        for (Member member : members) {
            byte[] header = new byte[512];
            put(header, 0, 100, member.path);
            number(header, 100, 8, member.mode);
            number(header, 108, 8, 0);
            number(header, 116, 8, 0);
            number(header, 124, 12, member.content.length);
            number(header, 136, 12, 0);
            for (int i = 148; i < 156; i++) header[i] = ' ';
            header[156] = (byte) member.type;
            put(header, 157, 100, member.target);
            put(header, 257, 6, "ustar");
            put(header, 263, 2, "00");
            number(header, 329, 8, 0);
            number(header, 337, 8, 0);
            int checksum = 0;
            for (byte value : header) checksum += value & 255;
            String octal = Integer.toOctalString(checksum);
            while (octal.length() < 6) octal = "0" + octal;
            put(header, 148, 8, octal + '\0' + ' ');
            result.write(header);
            result.write(member.content);
            int padding = (512 - member.content.length % 512) % 512;
            result.write(new byte[padding]);
        }
        result.write(new byte[1024]);
        return result.toByteArray();
    }

    private static void number(byte[] header, int offset, int length, long value) throws IOException {
        String octal = Long.toOctalString(value);
        while (octal.length() < length - 1) octal = "0" + octal;
        put(header, offset, length, octal);
    }

    private static void put(byte[] target, int offset, int length, String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.US_ASCII);
        check(bytes.length <= length, "Fixture USTAR field is too long");
        System.arraycopy(bytes, 0, target, offset, bytes.length);
    }

    private static JSONObject copy(JSONObject json) throws JSONException {
        return new JSONObject(json.toString());
    }

    private static String sha(byte[] bytes) {
        return RuntimeManifest.hex(RuntimeManifest.sha256().digest(bytes));
    }

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static String repeat(char character, int count) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < count; i++) text.append(character);
        return text.toString();
    }

    private static void write(File file, byte[] bytes) throws IOException {
        try (FileOutputStream stream = new FileOutputStream(file)) {
            stream.write(bytes);
            stream.getFD().sync();
        }
    }

    private static byte[] read(File file) throws IOException {
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        try (FileInputStream stream = new FileInputStream(file)) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = stream.read(buffer)) != -1) result.write(buffer, 0, count);
        }
        return result.toByteArray();
    }
}
