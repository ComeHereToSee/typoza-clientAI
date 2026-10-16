package syncsvc

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Secrets 是会话密钥:外壳把它存进钥匙串,辅助进程从不写盘。
type Secrets struct {
	Server       string `json:"server"`
	Email        string `json:"email"`
	UserID       string `json:"userId"`
	DeviceID     string `json:"deviceId"`
	AccountKey   []byte `json:"accountKey"`
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}

// VaultLink 是本机文件夹与云端库的对应关系。
type VaultLink struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Root string `json:"root"`
}

// config 是不含密钥的同步配置(数据目录下 config.json)。退出登录后仍保留,
// 用于预填登录表单,以及同一账号重新登录后接着同步原来的文件夹。
type config struct {
	Server   string      `json:"server"`
	Email    string      `json:"email"`
	UserID   string      `json:"userId"`
	DeviceID string      `json:"deviceId"`
	Vaults   []VaultLink `json:"vaults"`
}

func loadConfig(path string) (config, error) {
	var c config
	b, err := os.ReadFile(path) // #nosec G304 -- 辅助进程数据目录下固定的配置文件
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, fmt.Errorf("读取同步配置: %w", err)
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("同步配置 %s 已损坏: %w", path, err)
	}
	return c, nil
}

// saveConfig 原子写入(临时文件 + rename),权限 0600。
func saveConfig(path string, c config) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("编码同步配置: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("创建数据目录: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("写同步配置: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return fmt.Errorf("写同步配置: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("写同步配置: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("写同步配置: %w", err)
	}
	return nil
}

// normalizeServer 把用户填写的服务器地址整理成 sdk 需要的形式:补 https://、去掉结尾的 / 与 /v1。
func normalizeServer(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("请填写服务器地址")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("服务器地址 %q 无效", raw)
	}
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/v1")
	u.RawQuery, u.Fragment = "", ""
	return strings.TrimRight(u.String(), "/"), nil
}

// overlaps 判断两个绝对路径是否相同或互为上下级。
func overlaps(a, b string) bool {
	if a == b {
		return true
	}
	sep := string(filepath.Separator)
	return strings.HasPrefix(a, strings.TrimSuffix(b, sep)+sep) || strings.HasPrefix(b, strings.TrimSuffix(a, sep)+sep)
}

// relIn 返回 abs 在 root 下的相对路径('/' 分隔);不在 root 下时 ok=false。
func relIn(root, abs string) (string, bool) {
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}
