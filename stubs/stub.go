package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/gzip"
)

type Config struct {
	Identifier           string   `json:"identifier"`
	Command              []string `json:"command"`
	UncompressionMessage string   `json:"uncompressionMessage"`
}

type fileJob struct {
	dest string
	data []byte
	mode int64
}

const maxBufferSize = 1 * 1024 * 1024

func main() {
	exePath, err := os.Executable()
	if err != nil {
		log.Fatalf("caxa: failed to find executable: %v", err)
	}

	data, err := os.ReadFile(exePath)
	if err != nil {
		log.Fatalf("caxa: failed to read executable: %v", err)
	}

	config, payload, err := parseBinary(data)
	if err != nil {
		log.Fatalf("caxa: binary corrupted: %v", err)
	}

	appDir, err := prepareApplication(config, payload)
	if err != nil {
		log.Fatalf("caxa: failed to prepare application: %v", err)
	}

	if err := run(config, appDir); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		log.Fatalf("caxa: execution failed: %v", err)
	}
}

func parseBinary(data []byte) (*Config, []byte, error) {
	footerSep := []byte("\n")
	footerIdx := bytes.LastIndex(data, footerSep)
	if footerIdx == -1 {
		return nil, nil, errors.New("footer not found")
	}

	var config Config
	if err := json.Unmarshal(data[footerIdx+1:], &config); err != nil {
		return nil, nil, fmt.Errorf("invalid footer json: %w", err)
	}

	archiveSep := []byte("\nCAXACAXACAXA\n")
	archiveIdx := bytes.Index(data, archiveSep)
	if archiveIdx == -1 {
		return nil, nil, errors.New("archive separator not found")
	}

	payload := data[archiveIdx+len(archiveSep) : footerIdx]
	return &config, payload, nil
}

func prepareApplication(config *Config, payload []byte) (string, error) {
	tempDir := os.Getenv("CAXA_TEMP_DIR")
	if tempDir == "" {
		tempDir = path.Join(os.TempDir(), "caxa")
	}

	for attempt := 0; ; attempt++ {
		id := config.Identifier
		sAttempt := strconv.Itoa(attempt)

		appDir := path.Join(tempDir, "apps", id, sAttempt)
		lockDir := path.Join(tempDir, "locks", id, sAttempt)

		if info, err := os.Stat(appDir); err == nil && info.IsDir() {
			if _, err := os.Stat(lockDir); os.IsNotExist(err) {
				return appDir, nil
			}
			continue
		}

		if err := os.MkdirAll(lockDir, 0755); err != nil {
			return "", fmt.Errorf("failed to create lock: %w", err)
		}

		ctx, cancel := context.WithCancel(context.Background())
		if config.UncompressionMessage != "" {
			fmt.Fprint(os.Stderr, config.UncompressionMessage)
			go func() {
				t := time.NewTicker(2 * time.Second)
				defer t.Stop()
				for {
					select {
					case <-t.C:
						fmt.Fprint(os.Stderr, ".")
					case <-ctx.Done():
						fmt.Fprintln(os.Stderr, "")
						return
					}
				}
			}()
		}

		if err := extract(payload, appDir); err != nil {
			cancel()
			os.RemoveAll(appDir)
			os.RemoveAll(lockDir)
			return "", err
		}

		os.RemoveAll(lockDir)
		cancel()
		return appDir, nil
	}
}

func extract(payload []byte, dest string) error {
	gr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer gr.Close()

	tr := tar.NewReader(gr)

	numWorkers := runtime.NumCPU()
	jobs := make(chan fileJob, numWorkers*2)
	errChan := make(chan error, numWorkers)
	var wg sync.WaitGroup

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				if err := os.MkdirAll(filepath.Dir(job.dest), 0755); err != nil {
					select {
					case errChan <- err:
					default:
					}
					return
				}
				if err := os.WriteFile(job.dest, job.data, os.FileMode(job.mode)); err != nil {
					select {
					case errChan <- err:
					default:
					}
					return
				}
			}
		}()
	}

	for {
		select {
		case err := <-errChan:
			close(jobs)
			return err
		default:
		}

		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			close(jobs)
			return err
		}

		target := filepath.Join(dest, filepath.FromSlash(header.Name))

		if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
			close(jobs)
			return fmt.Errorf("illegal file path: %s", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0755); err != nil {
				close(jobs)
				return err
			}
		case tar.TypeReg:
			if header.Size < maxBufferSize {
				buf := make([]byte, header.Size)
				if _, err := io.ReadFull(tr, buf); err != nil {
					close(jobs)
					return err
				}
				jobs <- fileJob{dest: target, data: buf, mode: header.Mode}
			} else {
				if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
					close(jobs)
					return err
				}
				f, err := os.OpenFile(target, os.O_CREATE|os.O_RDWR, os.FileMode(header.Mode))
				if err != nil {
					close(jobs)
					return err
				}
				if _, err := io.Copy(f, tr); err != nil {
					f.Close()
					close(jobs)
					return err
				}
				f.Close()
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				close(jobs)
				return err
			}
			_ = os.Remove(target)
			if err := os.Symlink(header.Linkname, target); err != nil {
				close(jobs)
				return err
			}
		}
	}

	close(jobs)
	wg.Wait()

	select {
	case err := <-errChan:
		return err
	default:
		return nil
	}
}

func run(config *Config, appDir string) error {
	args := make([]string, len(config.Command))
	rx := regexp.MustCompile(`\{\{\s*caxa\s*\}\}`)

	for i, part := range config.Command {
		args[i] = rx.ReplaceAllLiteralString(part, appDir)
	}

	if len(os.Args) > 1 {
		args = append(args, os.Args[1:]...)
	}

	if len(args) == 0 {
		return errors.New("no command defined")
	}

	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}