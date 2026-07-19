package imagemounter

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"howett.net/plist"
)

// tssClient is used to talk to https://gs.apple.com/TSS for getting the personalized developer disk image signatures
type tssClient struct {
	h *http.Client
}

func newTssClient() tssClient {
	c := &http.Client{
		Timeout:   1 * time.Minute,
		Transport: http.DefaultTransport,
	}

	return tssClient{
		h: c,
	}
}

func (t tssClient) getSignature(identity buildIdentity, identifiers personalizationIdentifiers, nonce []byte, ecid uint64) ([]byte, error) {
	params := map[string]interface{}{
		"@ApImg4Ticket":     true,
		"@BBTicket":         true,
		"@HostPlatformInfo": "mac",
		"@VersionInfo":      "libauthinstall-1104.0.9",
		"@UUID":             uuid.New().String(),
		"ApBoardID":         identifiers.BoardId,
		"ApChipID":          identifiers.ChipID,
		"ApECID":            ecid,
		"ApNonce":           nonce,
		"ApProductionMode":  true,
		"ApSecurityDomain":  identifiers.SecurityDomain,
		"ApSecurityMode":    true,
		"SepNonce":          make([]byte, 20),
		"UID_MODE":          false,
	}

	// EPRO/ESEC are not present on the raw manifest entries — they are derived
	// from the manifest's RestoreRequestRules (carried on the LoadableTrustCache
	// component). Reading entry.EPRO/entry.ESEC directly yields false, and TSS then
	// rejects the request with status 94 ("device isn't eligible for the requested
	// build"). A DDI mount is always production + secure + Img4, under which the
	// rules resolve EPRO=true and ESEC=true. Evaluate the rules exactly like
	// idevicerestore/pymobiledevice3 do so the flags match what Apple expects.
	ruleParams := map[string]interface{}{
		"ApProductionMode": true,
		"ApSecurityMode":   true,
		"ApSupportsImg4":   true,
	}
	var rules []restoreRequestRule
	if ltc, ok := identity.Manifest["LoadableTrustCache"]; ok {
		rules = ltc.Info.RestoreRequestRules
	}

	for key, entry := range identity.Manifest {
		if !entry.Trusted {
			continue
		}
		entryParams := map[string]interface{}{
			"Digest":  entry.Digest,
			"Trusted": true,
			"EPRO":    entry.EPRO,
			"ESEC":    entry.ESEC,
		}
		applyRestoreRequestRules(entryParams, ruleParams, rules)
		if key == "PersonalizedDMG" || key == "PersonalizedDmg" {
			if entry.Name != "" {
				entryParams["Name"] = entry.Name
			} else {
				entryParams["Name"] = "DeveloperDiskImage"
			}
		}
		params[key] = entryParams
	}

	for k, v := range identifiers.AdditionalIdentifiers {
		params[k] = v
	}

	buf := bytes.NewBuffer(nil)
	enc := plist.NewEncoderForFormat(buf, plist.XMLFormat)
	err := enc.Encode(params)
	if err != nil {
		return nil, fmt.Errorf("getSignature: failed to encode request body: %w", err)
	}

	h := http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: true,
			},
			Proxy: t.h.Transport.(*http.Transport).Proxy,
		},
		Timeout: 1 * time.Minute,
	}
	req, err := http.NewRequest("POST", "https://gs.apple.com/TSS/controller?action=2", buf)
	if err != nil {
		return nil, err
	}
	res, err := h.Do(req)
	if err != nil {
		return nil, fmt.Errorf("getSignature: failed to send request: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusOK {
		resp, err := parseResponse(res.Body)
		if err != nil {
			return nil, fmt.Errorf("getSignature: failed to parse response: %w", err)
		}
		if resp.status != 0 {
			return nil, fmt.Errorf("unexpected status in response %d", resp.status)
		}
		var ticket map[string]interface{}
		_, err = plist.Unmarshal([]byte(resp.requestString), &ticket)
		if err != nil {
			return nil, fmt.Errorf("getSignature: failed to decode plist data: %w", err)
		}
		if ticket, ok := ticket["ApImg4Ticket"].([]byte); ok {
			return ticket, nil
		} else {
			return nil, fmt.Errorf("getSignature: could not get 'ApImg4Ticket' value from response")
		}
	}
	return nil, fmt.Errorf("getSignature: unexpected response status %d", res.StatusCode)
}

// applyRestoreRequestRules mutates a TSS component entry by applying every rule
// whose Conditions are all satisfied by params — a faithful port of
// pymobiledevice3's TSSRequest.apply_restore_request_rules. Condition keys map to
// the personalization parameters; a missing/falsy parameter fails the condition
// (matching pymobiledevice3's `value == value2 if value2 else False`). Action
// values of 255 are sentinels and skipped.
func applyRestoreRequestRules(entry, params map[string]interface{}, rules []restoreRequestRule) {
	for _, rule := range rules {
		fulfilled := true
		for key, want := range rule.Conditions {
			var have interface{}
			switch key {
			case "ApRawProductionMode", "ApCurrentProductionMode":
				have = params["ApProductionMode"]
			case "ApRawSecurityMode":
				have = params["ApSecurityMode"]
			case "ApRequiresImage4":
				have = params["ApSupportsImg4"]
			case "ApDemotionPolicyOverride":
				have = params["DemotionPolicy"]
			case "ApInRomDFU":
				have = params["ApInRomDFU"]
			default:
				have = nil
			}
			if !isTruthy(have) || !reflect.DeepEqual(want, have) {
				fulfilled = false
				break
			}
		}
		if !fulfilled {
			continue
		}
		for key, value := range rule.Actions {
			if n, ok := value.(uint64); ok && n == 255 {
				continue
			}
			entry[key] = value
		}
	}
}

func isTruthy(v interface{}) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case uint64:
		return t != 0
	case int64:
		return t != 0
	default:
		return true
	}
}

type response struct {
	status        int
	message       string
	requestString string
}

func parseResponse(r io.Reader) (response, error) {
	b, err := io.ReadAll(r)
	if err != nil {
		return response{}, fmt.Errorf("parseResponse: could not read content. %w", err)
	}
	s := string(b)
	end := func(s string) int {
		idx := strings.Index(s, "&")
		if idx < 0 {
			return len(s)
		} else {
			return idx
		}
	}

	var res response

	statusIdx := strings.Index(s, "STATUS=")
	if statusIdx >= 0 {
		statusStart := statusIdx + len("STATUS=")
		status := s[statusStart:]
		statusEnd := end(status)
		status = status[:statusEnd]
		stat, err := strconv.ParseInt(status, 10, 64)
		if err != nil {
			return response{}, fmt.Errorf("parseResponse: could not parse status '%s'. %w", status, err)
		}
		res.status = int(stat)
	}
	messageIdx := strings.Index(s, "MESSAGE=")
	if messageIdx >= 0 {
		messageStart := messageIdx + len("MESSAGE=")
		message := s[messageStart:]
		messageEnd := end(message)
		message = message[:messageEnd]
		res.message = message
	}

	requestStringIdx := strings.Index(s, "REQUEST_STRING=")
	if requestStringIdx >= 0 {
		if requestStringIdx <= messageIdx || requestStringIdx <= statusIdx {
			return response{}, fmt.Errorf("REQUEST_STRING value must come last")
		}
		requestStringStart := requestStringIdx + len("REQUEST_STRING=")
		requestString := s[requestStringStart:]
		requestStringEnd := end(requestString)
		requestString = requestString[:requestStringEnd]
		res.requestString = requestString
	}

	return res, nil
}
