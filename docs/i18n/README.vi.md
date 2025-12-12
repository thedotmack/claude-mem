🌐 Đây là bản dịch tự động. Chúng tôi hoan nghênh các đóng góp từ cộng đồng!

---
<h1 align="center">
  <br>
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp" alt="Claude-Mem" width="400">
    </picture>
  </a>
  <br>
</h1>

<h4 align="center">Hệ thống nén bộ nhớ lâu dài được xây dựng cho <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-6.5.0-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node">
  </a>
  <a href="https://github.com/thedotmack/awesome-claude-code">
    <img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
  </a>
</p>

<br>

<p align="center">
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif" alt="Claude-Mem Preview" width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#bắt-đầu-nhanh">Bắt Đầu Nhanh</a> •
  <a href="#cách-hoạt-động">Cách Hoạt Động</a> •
  <a href="#công-cụ-tìm-kiếm-mcp">Công Cụ Tìm Kiếm</a> •
  <a href="#tài-liệu">Tài Liệu</a> •
  <a href="#cấu-hình">Cấu Hình</a> •
  <a href="#khắc-phục-sự-cố">Khắc Phục Sự Cố</a> •
  <a href="#giấy-phép">Giấy Phép</a>
</p>

<p align="center">
  Claude-Mem duy trì ngữ cảnh một cách liền mạch qua các phiên làm việc bằng cách tự động ghi lại các quan sát từ việc sử dụng công cụ, tạo các bản tóm tắt ngữ nghĩa, và cung cấp chúng cho các phiên tương lai. Điều này cho phép Claude duy trì sự liên tục của kiến thức về dự án ngay cả sau khi các phiên kết thúc hoặc kết nối lại.
</p>

---

## Bắt Đầu Nhanh

Bắt đầu một phiên Claude Code mới trong terminal và nhập các lệnh sau:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Khởi động lại Claude Code. Ngữ cảnh từ các phiên trước sẽ tự động xuất hiện trong các phiên mới.

**Tính Năng Chính:**

- 🧠 **Bộ Nhớ Lâu Dài** - Ngữ cảnh được duy trì qua các phiên
- 📊 **Progressive Disclosure** - Truy xuất bộ nhớ theo lớp với khả năng hiển thị chi phí token
- 🔍 **Tìm Kiếm Dựa Trên Kỹ Năng** - Truy vấn lịch sử dự án với kỹ năng mem-search (tiết kiệm ~2,250 token)
- 🖥️ **Giao Diện Web Viewer** - Luồng bộ nhớ thời gian thực tại http://localhost:37777
- 🔒 **Kiểm Soát Quyền Riêng Tư** - Sử dụng thẻ `<private>` để loại trừ nội dung nhạy cảm khỏi lưu trữ
- ⚙️ **Cấu Hình Ngữ Cảnh** - Kiểm soát chi tiết về ngữ cảnh được tiêm vào
- 🤖 **Hoạt Động Tự Động** - Không cần can thiệp thủ công
- 🔗 **Trích Dẫn** - Tham chiếu các quyết định trong quá khứ với URI `claude-mem://`
- 🧪 **Kênh Beta** - Dùng thử các tính năng thử nghiệm như Endless Mode thông qua chuyển đổi phiên bản

---

## Tài Liệu

📚 **[Xem Tài Liệu Đầy Đủ](docs/)** - Duyệt tài liệu markdown trên GitHub

💻 **Xem Trước Cục Bộ**: Chạy tài liệu Mintlify trên máy:

```bash
cd docs
npx mintlify dev
```

### Bắt Đầu

- **[Hướng Dẫn Cài Đặt](https://docs.claude-mem.ai/installation)** - Bắt đầu nhanh & cài đặt nâng cao
- **[Hướng Dẫn Sử Dụng](https://docs.claude-mem.ai/usage/getting-started)** - Cách Claude-Mem hoạt động tự động
- **[Công Cụ Tìm Kiếm](https://docs.claude-mem.ai/usage/search-tools)** - Truy vấn lịch sử dự án bằng ngôn ngữ tự nhiên
- **[Tính Năng Beta](https://docs.claude-mem.ai/beta-features)** - Dùng thử các tính năng thử nghiệm như Endless Mode

### Phương Pháp Hay Nhất

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Nguyên tắc tối ưu hóa ngữ cảnh cho AI agent
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - Triết lý đằng sau chiến lược chuẩn bị ngữ cảnh của Claude-Mem

### Kiến Trúc

- **[Tổng Quan](https://docs.claude-mem.ai/architecture/overview)** - Các thành phần hệ thống & luồng dữ liệu
- **[Phát Triển Kiến Trúc](https://docs.claude-mem.ai/architecture-evolution)** - Hành trình từ v3 đến v5
- **[Kiến Trúc Hooks](https://docs.claude-mem.ai/hooks-architecture)** - Cách Claude-Mem sử dụng lifecycle hooks
- **[Tài Liệu Hooks](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook script được giải thích
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & quản lý PM2
- **[Cơ Sở Dữ Liệu](https://docs.claude-mem.ai/architecture/database)** - Cấu trúc SQLite & tìm kiếm FTS5
- **[Kiến Trúc Tìm Kiếm](https://docs.claude-mem.ai/architecture/search-architecture)** - Tìm kiếm lai với cơ sở dữ liệu vector Chroma

### Cấu Hình & Phát Triển

- **[Cấu Hình](https://docs.claude-mem.ai/configuration)** - Biến môi trường & cài đặt
- **[Phát Triển](https://docs.claude-mem.ai/development)** - Xây dựng, kiểm thử, đóng góp
- **[Khắc Phục Sự Cố](https://docs.claude-mem.ai/troubleshooting)** - Các vấn đề thường gặp & giải pháp

---

## Cách Hoạt Động

```
┌─────────────────────────────────────────────────────────────┐
│ Bắt Đầu Phiên → Tiêm các quan sát gần đây làm ngữ cảnh     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Lời Nhắc Người Dùng → Tạo phiên, lưu lời nhắc người dùng    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Thực Thi Công Cụ → Ghi lại quan sát (Read, Write, v.v.)     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Xử Lý Worker → Trích xuất kiến thức qua Claude Agent SDK    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Kết Thúc Phiên → Tạo bản tóm tắt, sẵn sàng cho phiên tiếp   │
└─────────────────────────────────────────────────────────────┘
```

**Các Thành Phần Cốt Lõi:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook script)
2. **Smart Install** - Bộ kiểm tra dependency có cache (pre-hook script, không phải lifecycle hook)
3. **Worker Service** - HTTP API trên cổng 37777 với giao diện web viewer và 10 endpoint tìm kiếm, được quản lý bởi PM2
4. **Cơ Sở Dữ Liệu SQLite** - Lưu trữ phiên, quan sát, bản tóm tắt với tìm kiếm toàn văn FTS5
5. **Kỹ Năng mem-search** - Truy vấn ngôn ngữ tự nhiên với progressive disclosure (tiết kiệm ~2,250 token so với MCP)
6. **Cơ Sở Dữ Liệu Vector Chroma** - Tìm kiếm lai ngữ nghĩa + từ khóa cho việc truy xuất ngữ cảnh thông minh

Xem [Tổng Quan Kiến Trúc](https://docs.claude-mem.ai/architecture/overview) để biết chi tiết.

---

## Kỹ Năng mem-search

Claude-Mem cung cấp tìm kiếm thông minh thông qua kỹ năng mem-search tự động kích hoạt khi bạn hỏi về công việc trong quá khứ:

**Cách Hoạt Động:**
- Chỉ cần hỏi tự nhiên: *"Chúng ta đã làm gì trong phiên trước?"* hoặc *"Chúng ta đã sửa lỗi này trước đây chưa?"*
- Claude tự động gọi kỹ năng mem-search để tìm ngữ cảnh liên quan
- Tiết kiệm ~2,250 token mỗi lần bắt đầu phiên so với phương pháp MCP

**Các Thao Tác Tìm Kiếm Có Sẵn:**

1. **Tìm Kiếm Quan Sát** - Tìm kiếm toàn văn trên các quan sát
2. **Tìm Kiếm Phiên** - Tìm kiếm toàn văn trên các bản tóm tắt phiên
3. **Tìm Kiếm Lời Nhắc** - Tìm kiếm các yêu cầu người dùng thô
4. **Theo Khái Niệm** - Tìm theo thẻ khái niệm (discovery, problem-solution, pattern, v.v.)
5. **Theo File** - Tìm quan sát tham chiếu đến file cụ thể
6. **Theo Loại** - Tìm theo loại (decision, bugfix, feature, refactor, discovery, change)
7. **Ngữ Cảnh Gần Đây** - Lấy ngữ cảnh phiên gần đây cho một dự án
8. **Dòng Thời Gian** - Lấy dòng thời gian thống nhất của ngữ cảnh xung quanh một điểm thời gian cụ thể
9. **Dòng Thời Gian Theo Truy Vấn** - Tìm kiếm quan sát và lấy ngữ cảnh dòng thời gian xung quanh kết quả khớp tốt nhất
10. **Trợ Giúp API** - Lấy tài liệu API tìm kiếm

**Ví Dụ Truy Vấn Ngôn Ngữ Tự Nhiên:**

```
"Chúng ta đã sửa những lỗi gì trong phiên trước?"
"Chúng ta đã triển khai xác thực như thế nào?"
"Những thay đổi nào đã được thực hiện đối với worker-service.ts?"
"Hiển thị cho tôi công việc gần đây trên dự án này"
"Điều gì đang xảy ra khi chúng ta thêm giao diện viewer?"
```

Xem [Hướng Dẫn Công Cụ Tìm Kiếm](https://docs.claude-mem.ai/usage/search-tools) để biết ví dụ chi tiết.

---

## Tính Năng Beta & Endless Mode

Claude-Mem cung cấp **kênh beta** với các tính năng thử nghiệm. Chuyển đổi giữa phiên bản ổn định và beta trực tiếp từ giao diện web viewer.

### Cách Dùng Thử Beta

1. Mở http://localhost:37777
2. Nhấp vào Settings (biểu tượng bánh răng)
3. Trong **Version Channel**, nhấp "Try Beta (Endless Mode)"
4. Đợi worker khởi động lại

Dữ liệu bộ nhớ của bạn được bảo toàn khi chuyển đổi phiên bản.

### Endless Mode (Beta)

Tính năng beta hàng đầu là **Endless Mode** - một kiến trúc bộ nhớ mô phỏng sinh học kéo dài đáng kể thời lượng phiên:

**Vấn Đề**: Các phiên Claude Code tiêu chuẩn chạm giới hạn ngữ cảnh sau ~50 lần sử dụng công cụ. Mỗi công cụ thêm 1-10k+ token, và Claude tổng hợp lại tất cả đầu ra trước đó ở mỗi phản hồi (độ phức tạp O(N²)).

**Giải Pháp**: Endless Mode nén đầu ra công cụ thành các quan sát ~500 token và chuyển đổi bản ghi thời gian thực:

```
Bộ Nhớ Làm Việc (Ngữ cảnh):    Các quan sát đã nén (~500 token mỗi cái)
Bộ Nhớ Lưu Trữ (Đĩa):          Đầu ra công cụ đầy đủ được bảo toàn để gọi lại
```

**Kết Quả Mong Đợi**:
- Giảm ~95% token trong cửa sổ ngữ cảnh
- Gấp ~20 lần số lần sử dụng công cụ trước khi cạn kiệt ngữ cảnh
- Tỷ lệ tuyến tính O(N) thay vì bậc hai O(N²)
- Bản ghi đầy đủ được bảo toàn để gợi nhớ hoàn hảo

**Lưu Ý**: Thêm độ trễ (60-90s mỗi công cụ để tạo quan sát), vẫn đang thử nghiệm.

Xem [Tài Liệu Tính Năng Beta](https://docs.claude-mem.ai/beta-features) để biết chi tiết.

---

## Có Gì Mới

**v6.4.9 - Cài Đặt Cấu Hình Ngữ Cảnh:**
- 11 cài đặt mới cho kiểm soát chi tiết về việc tiêm ngữ cảnh
- Cấu hình hiển thị token economics, lọc quan sát theo loại/khái niệm
- Kiểm soát số lượng quan sát và các trường cần hiển thị

**v6.4.0 - Hệ Thống Quyền Riêng Tư Hai Thẻ:**
- Thẻ `<private>` cho quyền riêng tư do người dùng kiểm soát - bao bọc nội dung nhạy cảm để loại trừ khỏi lưu trữ
- Thẻ `<claude-mem-context>` cấp hệ thống ngăn lưu trữ quan sát đệ quy
- Xử lý cạnh đảm bảo nội dung riêng tư không bao giờ đến cơ sở dữ liệu

**v6.3.0 - Kênh Phiên Bản:**
- Chuyển đổi giữa phiên bản ổn định và beta từ giao diện web viewer
- Dùng thử các tính năng thử nghiệm như Endless Mode mà không cần thao tác git thủ công

**Điểm Nổi Bật Trước Đây:**
- **v6.0.0**: Cải thiện lớn về quản lý phiên & xử lý bản ghi
- **v5.5.0**: Nâng cao kỹ năng mem-search với tỷ lệ hiệu quả 100%
- **v5.4.0**: Kiến trúc tìm kiếm dựa trên kỹ năng (tiết kiệm ~2,250 token mỗi phiên)
- **v5.1.0**: Giao diện viewer dựa trên web với cập nhật thời gian thực
- **v5.0.0**: Tìm kiếm lai với cơ sở dữ liệu vector Chroma

Xem [CHANGELOG.md](CHANGELOG.md) để biết lịch sử phiên bản đầy đủ.

---

## Yêu Cầu Hệ Thống

- **Node.js**: 18.0.0 trở lên
- **Claude Code**: Phiên bản mới nhất với hỗ trợ plugin
- **PM2**: Trình quản lý tiến trình (đi kèm - không cần cài đặt toàn cục)
- **SQLite 3**: Cho lưu trữ lâu dài (đi kèm)

---

## Lợi Ích Chính

### Ngữ Cảnh Progressive Disclosure

- **Truy xuất bộ nhớ theo lớp** phản ánh mô hình bộ nhớ của con người
- **Lớp 1 (Chỉ mục)**: Xem những quan sát tồn tại với chi phí token khi bắt đầu phiên
- **Lớp 2 (Chi tiết)**: Lấy câu chuyện đầy đủ theo yêu cầu qua tìm kiếm MCP
- **Lớp 3 (Gợi Nhớ Hoàn Hảo)**: Truy cập mã nguồn và bản ghi gốc
- **Ra quyết định thông minh**: Số lượng token giúp Claude chọn giữa việc lấy chi tiết hoặc đọc mã
- **Chỉ báo loại**: Gợi ý trực quan (🔴 quan trọng, 🟤 quyết định, 🔵 thông tin) làm nổi bật tầm quan trọng của quan sát

### Bộ Nhớ Tự Động

- Ngữ cảnh tự động được tiêm khi Claude khởi động
- Không cần lệnh hoặc cấu hình thủ công
- Hoạt động minh bạch ở chế độ nền

### Tìm Kiếm Lịch Sử Đầy Đủ

- Tìm kiếm trên tất cả các phiên và quan sát
- Tìm kiếm toàn văn FTS5 cho truy vấn nhanh
- Trích dẫn liên kết ngược đến các quan sát cụ thể

### Quan Sát Có Cấu Trúc

- Trích xuất kiến thức được hỗ trợ bởi AI
- Phân loại theo loại (decision, bugfix, feature, v.v.)
- Gắn thẻ với khái niệm và tham chiếu file

### Phiên Đa Lời Nhắc

- Các phiên trải dài nhiều lời nhắc người dùng
- Ngữ cảnh được bảo toàn qua các lệnh `/clear`
- Theo dõi toàn bộ luồng hội thoại

---

## Cấu Hình

Cài đặt được quản lý trong `~/.claude-mem/settings.json`. File được tự động tạo với các giá trị mặc định khi chạy lần đầu.

**Cài Đặt Có Sẵn:**

| Cài Đặt | Mặc Định | Mô Tả |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | Mô hình AI cho quan sát |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Cổng worker service |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Vị trí thư mục dữ liệu |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Mức độ chi tiết log (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Phiên bản Python cho chroma-mcp |
| `CLAUDE_CODE_PATH` | _(tự động phát hiện)_ | Đường dẫn đến file thực thi Claude |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Số lượng quan sát để tiêm tại SessionStart |

**Quản Lý Cài Đặt:**

```bash
# Chỉnh sửa cài đặt qua CLI helper
./claude-mem-settings.sh

# Hoặc chỉnh sửa trực tiếp
nano ~/.claude-mem/settings.json

# Xem cài đặt hiện tại
curl http://localhost:37777/api/settings
```

**Định Dạng File Cài Đặt:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Xem [Hướng Dẫn Cấu Hình](https://docs.claude-mem.ai/configuration) để biết chi tiết.

---

## Phát Triển

```bash
# Clone và build
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Chạy tests
npm test

# Khởi động worker
npm run worker:start

# Xem logs
npm run worker:logs
```

Xem [Hướng Dẫn Phát Triển](https://docs.claude-mem.ai/development) để biết hướng dẫn chi tiết.

---

## Khắc Phục Sự Cố

**Chẩn Đoán Nhanh:**

Nếu bạn gặp sự cố, mô tả vấn đề cho Claude và kỹ năng troubleshoot sẽ tự động kích hoạt để chẩn đoán và cung cấp giải pháp.

**Các Vấn Đề Thường Gặp:**

- Worker không khởi động → `npm run worker:restart`
- Không có ngữ cảnh xuất hiện → `npm run test:context`
- Vấn đề cơ sở dữ liệu → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Tìm kiếm không hoạt động → Kiểm tra các bảng FTS5 có tồn tại

Xem [Hướng Dẫn Khắc Phục Sự Cố](https://docs.claude-mem.ai/troubleshooting) để biết giải pháp đầy đủ.

---

## Đóng Góp

Chúng tôi hoan nghênh các đóng góp! Vui lòng:

1. Fork repository
2. Tạo nhánh tính năng
3. Thực hiện các thay đổi với tests
4. Cập nhật tài liệu
5. Gửi Pull Request

Xem [Hướng Dẫn Phát Triển](https://docs.claude-mem.ai/development) để biết quy trình đóng góp.

---

## Giấy Phép

Dự án này được cấp phép theo **Giấy Phép Công Cộng GNU Affero phiên bản 3.0** (AGPL-3.0).

Bản quyền (C) 2025 Alex Newman (@thedotmack). Mọi quyền được bảo lưu.

Xem file [LICENSE](LICENSE) để biết chi tiết đầy đủ.

**Điều Này Có Nghĩa Là:**

- Bạn có thể sử dụng, sửa đổi và phân phối phần mềm này một cách tự do
- Nếu bạn sửa đổi và triển khai trên máy chủ mạng, bạn phải cung cấp mã nguồn của mình
- Các sản phẩm phái sinh cũng phải được cấp phép theo AGPL-3.0
- KHÔNG CÓ BẢO HÀNH cho phần mềm này

---

## Hỗ Trợ

- **Tài Liệu**: [docs/](docs/)
- **Vấn Đề**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Tác Giả**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Được Xây Dựng Với Claude Agent SDK** | **Được Hỗ Trợ Bởi Claude Code** | **Được Tạo Với TypeScript**