package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func createMockPayload(files map[string][]byte, compression string) ([]byte, error) {
	var buf bytes.Buffer

	var (
		tarBuffer bytes.Buffer
		writer    interface{ Close() error }
	)
	tw := tar.NewWriter(&tarBuffer)

	for name, content := range files {
		header := &tar.Header{
			Name: name,
			Mode: 0600,
			Size: int64(len(content)),
		}
		if err := tw.WriteHeader(header); err != nil {
			return nil, err
		}
		if _, err := tw.Write(content); err != nil {
			return nil, err
		}
	}

	if err := tw.Close(); err != nil {
		return nil, err
	}

	switch compression {
	case "", "gzip":
		gw := gzip.NewWriter(&buf)
		writer = gw
		if _, err := gw.Write(tarBuffer.Bytes()); err != nil {
			return nil, err
		}
	case "zstd":
		zw, err := zstd.NewWriter(&buf)
		if err != nil {
			return nil, err
		}
		writer = zw
		if _, err := zw.Write(tarBuffer.Bytes()); err != nil {
			return nil, err
		}
	default:
		return nil, nil
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}

func TestParseBinary(t *testing.T) {
	payloadData := []byte("mock-compressed-data")
	separator := []byte("\nCAXACAXACAXA\n")

	config := Config{
		Identifier: "test-id",
		Command:    []string{"node", "index.js"},
	}
	configData, _ := json.Marshal(config)

	var binaryBuilder bytes.Buffer
	binaryBuilder.Write([]byte("some-binary-code-here"))
	binaryBuilder.Write(separator)
	binaryBuilder.Write(payloadData)
	binaryBuilder.Write([]byte("\n"))
	binaryBuilder.Write(configData)

	parsedConfig, parsedPayload, err := parseBinary(binaryBuilder.Bytes())
	if err != nil {
		t.Fatalf("parseBinary failed: %v", err)
	}

	if parsedConfig.Identifier != "test-id" {
		t.Errorf("Expected identifier 'test-id', got '%s'", parsedConfig.Identifier)
	}
	if !bytes.Equal(parsedPayload, payloadData) {
		t.Errorf("Payload mismatch")
	}
}

func TestInspectBinary_WithTrailer(t *testing.T) {
	payload, err := createMockPayload(map[string][]byte{
		"index.js": []byte("console.log('ok')"),
	}, "gzip")
	if err != nil {
		t.Fatalf("Failed to create mock payload: %v", err)
	}

	config := Config{
		Identifier: "trailer-test",
		Command:    []string{"node", "index.js"},
		Compression: "gzip",
	}
	footer, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("Failed to marshal config: %v", err)
	}

	var binaryBuilder bytes.Buffer
	binaryBuilder.Write([]byte("stub-bytes"))
	binaryBuilder.WriteString(archiveSeparator)
	payloadOffset := binaryBuilder.Len()
	binaryBuilder.Write(payload)
	binaryBuilder.Write(footer)

	trailer := make([]byte, trailerSize)
	copy(trailer[:8], []byte(trailerMagic))
	binary.LittleEndian.PutUint64(trailer[8:16], uint64(payloadOffset))
	binary.LittleEndian.PutUint64(trailer[16:24], uint64(len(payload)))
	binary.LittleEndian.PutUint64(trailer[24:32], uint64(len(footer)))
	binaryBuilder.Write(trailer)

	tempBinary, err := os.CreateTemp("", "caxa-binary-*")
	if err != nil {
		t.Fatalf("Failed to create temp binary: %v", err)
	}
	defer os.Remove(tempBinary.Name())

	if _, err := tempBinary.Write(binaryBuilder.Bytes()); err != nil {
		t.Fatalf("Failed to write temp binary: %v", err)
	}
	if err := tempBinary.Close(); err != nil {
		t.Fatalf("Failed to close temp binary: %v", err)
	}

	layout, err := inspectBinary(tempBinary.Name())
	if err != nil {
		t.Fatalf("inspectBinary failed: %v", err)
	}

	if layout.config.Identifier != config.Identifier {
		t.Fatalf("Expected identifier %q, got %q", config.Identifier, layout.config.Identifier)
	}
	if layout.payloadOffset != int64(payloadOffset) {
		t.Fatalf("Expected payloadOffset %d, got %d", payloadOffset, layout.payloadOffset)
	}
	if layout.payloadSize != int64(len(payload)) {
		t.Fatalf("Expected payloadSize %d, got %d", len(payload), layout.payloadSize)
	}
	if len(layout.payload) != 0 {
		t.Fatalf("Expected trailer-based layout to avoid eagerly loading payload data")
	}

	destDir, err := os.MkdirTemp("", "caxa-trailer-extract-*")
	if err != nil {
		t.Fatalf("Failed to create extract dir: %v", err)
	}
	defer os.RemoveAll(destDir)

	if err := extract(layout, tempBinary.Name(), destDir); err != nil {
		t.Fatalf("streaming extract failed: %v", err)
	}

	content, err := os.ReadFile(filepath.Join(destDir, "index.js"))
	if err != nil {
		t.Fatalf("Failed to read extracted file: %v", err)
	}
	if string(content) != "console.log('ok')" {
		t.Fatalf("Unexpected extracted content: %s", string(content))
	}
}

func TestExtract_Parallel_And_LargeFiles(t *testing.T) {
	smallContent := []byte("small-file")

	largeSize := 1024 * 1024 + 100
	largeContent := make([]byte, largeSize)
	rand.Read(largeContent)

	files := map[string][]byte{
		"small.txt":       smallContent,
		"subdir/test.txt": smallContent,
		"large.bin":       largeContent,
	}

	payload, err := createMockPayload(files, "gzip")
	if err != nil {
		t.Fatalf("Failed to create mock payload: %v", err)
	}

	destDir, err := os.MkdirTemp("", "caxa-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(destDir)

	if err := extract(&binaryLayout{payload: payload, config: &Config{Compression: "gzip"}}, "", destDir); err != nil {
		t.Fatalf("extract failed: %v", err)
	}

	checkFile := func(path string, expected []byte) {
		content, err := os.ReadFile(filepath.Join(destDir, path))
		if err != nil {
			t.Errorf("Failed to read extracted file %s: %v", path, err)
			return
		}
		if !bytes.Equal(content, expected) {
			t.Errorf("Content mismatch for %s", path)
		}
	}

	checkFile("small.txt", smallContent)
	checkFile("subdir/test.txt", smallContent)
	checkFile("large.bin", largeContent)
}

func TestExtract_ZipSlip_Security(t *testing.T) {
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	header := &tar.Header{
		Name: "../../../etc/passwd",
		Mode: 0600,
		Size: int64(4),
	}
	tw.WriteHeader(header)
	tw.Write([]byte("root"))
	tw.Close()
	gw.Close()

	destDir, _ := os.MkdirTemp("", "caxa-security-test-*")
	defer os.RemoveAll(destDir)

	err := extract(&binaryLayout{payload: buf.Bytes(), config: &Config{Compression: "gzip"}}, "", destDir)
	if err == nil {
		t.Fatal("Expected extract to fail on ZipSlip attempt, but it succeeded")
	}

	if !strings.Contains(err.Error(), "illegal file path") {
		t.Errorf("Expected 'illegal file path' error, got: %v", err)
	}
}

func TestExtract_ZstdPayload(t *testing.T) {
	payload, err := createMockPayload(map[string][]byte{
		"index.js": []byte("console.log('zstd-ok')"),
	}, "zstd")
	if err != nil {
		t.Fatalf("Failed to create zstd payload: %v", err)
	}

	destDir, err := os.MkdirTemp("", "caxa-zstd-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(destDir)

	if err := extract(&binaryLayout{payload: payload, config: &Config{Compression: "zstd"}}, "", destDir); err != nil {
		t.Fatalf("zstd extract failed: %v", err)
	}

	content, err := os.ReadFile(filepath.Join(destDir, "index.js"))
	if err != nil {
		t.Fatalf("Failed to read extracted zstd file: %v", err)
	}
	if string(content) != "console.log('zstd-ok')" {
		t.Fatalf("Unexpected extracted zstd content: %s", string(content))
	}
}