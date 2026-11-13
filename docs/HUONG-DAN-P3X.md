> Tài liệu tham khảo từ phiên bản trước. Trang Redis Lab đã được bỏ theo yêu cầu; ứng dụng hiện là cửa hàng và quản trị hàng đợi tại /admin.html#queue. Không dùng các đường dẫn/màn hình Redis Lab trong tài liệu này làm mô tả phiên bản hiện tại.

# Sổ tay thực hành P3X Redis UI

## 1. Mục tiêu

Dùng P3X làm công cụ chính để kết nối, quan sát, thao tác và quản trị Redis. Ứng dụng web chỉ tạo dữ liệu cho bài toán hàng đợi đơn hàng. Không gọi trang quản trị tự viết là P3X; P3X là ứng dụng riêng.

## 2. Cài đặt và kết nối đang dùng

- Docker container nguồn: redis-orders, cổng máy 6379 → Redis 6379.
- P3X desktop: mở kết nối Redis Orders Local (hoặc tên tương đương), Host 127.0.0.1, Port 6379.
- Ứng dụng dùng DB 1 mặc định. Xem `/api/health` để xác nhận DB thật nếu đã đổi `.env`.
- DB 0 là bộ mẫu cũ dùng viết tài liệu; không xóa hoặc coi DB 0 là dữ liệu đang chạy của ứng dụng.
- Không cần chạy container P3X vì đang dùng bản desktop. Lệnh đúng để mở Redis: `docker start redis-orders`.

Chọn DATABASE, DB 1, Refresh. Mở Console (nút ở thanh công cụ, vị trí tùy phiên bản):

```redis
PING
DBSIZE
SCAN 0 MATCH order:* COUNT 100
```

SCAN trả cursor và danh sách key, không bảo đảm đủ hoặc đúng 100 key mỗi lượt. Nếu cursor khác 0, dùng cursor đó thay số 0 rồi tiếp tục. SCAN có thể trả key trùng; không dùng số dòng SCAN làm tổng key.

## 3. Đối chiếu dữ liệu đang chạy

Tạm dừng nhận đơn trên Không gian đồ án → Hàng đợi trực tiếp. Đặt vài đơn từ `/shop.html`. Trên P3X:

```redis
TYPE order:queue
LRANGE order:queue 0 -1
LLEN order:queue
TYPE order:processing
LRANGE order:processing 0 -1
SMEMBERS order:status:PENDING
ZRANGE order:created 0 -1 WITHSCORES
XREVRANGE order:events + - COUNT 20
```

Chọn một mã đơn thật từ LRANGE, chạy `HGETALL order:<MA_THAT>` (thay cả dấu ngoặc). Đơn là Hash; `items` là chuỗi JSON chứa danh sách món, không phải RedisJSON. Score thời gian là mili giây. Stream chỉ là nhật ký của worker; hàng đợi chính là List.

Tiếp tục worker và Refresh P3X để thấy queue giảm, processing xuất hiện, Hash đổi trạng thái, Set đổi mã đơn, kho giảm khi COMPLETED. Mặc định xử lý 10 giây/đơn; số liệu trên web/P3X đọc ở các thời điểm khác nhau có thể lệch khi worker đang hoạt động.

## 4. Thao tác đủ các kiểu dữ liệu và TTL

Trang chính → Thực hành P3X → Tạo key thực hành. Các key lab: độc lập với đơn khách.

| Nội dung | Lệnh | Kết quả cần quan sát |
|---|---|---|
| String | `GET lab:note` | Chuỗi ghi chú |
| TTL | `TTL lab:note` | Giảm từ khoảng 120 đến hết hạn, sau đó -2 |
| Hash | `HGETALL lab:order:LAB001` | Field/value đơn thực hành |
| Sửa Hash | `HSET lab:order:LAB001 note "Thuc hanh"` | Xuất hiện field note |
| Xóa field | `HDEL lab:order:LAB001 note` | Chỉ field note bị xóa |
| List | `LRANGE lab:queue 0 -1` | LAB001 trước LAB002 ở bộ mới |
| Thêm List | `RPUSH lab:queue LAB003` | LAB003 ở cuối |
| Lấy List | `LPOP lab:queue` | Trả mã đầu và loại khỏi List |
| Set | `SADD lab:status:PENDING LAB003` | Thêm mã không trùng |
| Đếm Set | `SCARD lab:status:PENDING` | Số mã duy nhất |
| ZSet | `ZRANGEBYSCORE lab:created 1000 2000 WITHSCORES` | Các mã trong khoảng score |
| Stream | `XRANGE lab:events - + COUNT 10` | ID và field sự kiện |
| Xóa key | `DEL lab:order:LAB001` | Sau đó EXISTS trả 0 |

Có thể thao tác bằng giao diện key tương ứng của P3X rồi dùng Console kiểm chứng. Chụp màn hình cả tên key, DB và kết quả. Sau khi sửa/xóa lab:, nút tạo key chỉ bổ sung key thiếu, không đặt lại dữ liệu đã sửa. lab:note hết hạn thì có thể tạo lại.

Với order:, product:, customer: đang hoạt động, ưu tiên lệnh đọc. Chỉ sửa tồn qua quản trị sản phẩm để tổng tồn và tồn từng size khớp. Không LPOP hàng đợi thật bằng tay khi worker đang chạy.

## 5. Truy vấn nâng cao và thống kê

- `SCARD order:status:COMPLETED`: số đơn trong chỉ mục hoàn tất.
- `SINTER order:status:PENDING order:status:COMPLETED`: bình thường rỗng; cùng một đơn không đồng thời ở hai trạng thái.
- `ZRANGEBYSCORE order:created <TU_MILI_GIAY> <DEN_MILI_GIAY> WITHSCORES`: đơn tạo trong khoảng thời gian (thay các tham số bằng số thực).
- `XREVRANGE order:events + - COUNT 20`: 20 sự kiện gần nhất.
- Mở Hash đơn rồi đối chiếu status với Set tương ứng; với COMPLETED kiểm tra product.stock:<size>.

Ứng dụng dùng Lua cho chuyển trạng thái và kiểm tra/trừ tồn toàn đơn một cách nguyên tử. Điều này tránh hai bước kiểm tra và trừ kho bị xen kẽ. Lua không tự rollback các lệnh ghi đã chạy nếu có lỗi script, vì vậy code kiểm tra kiểu key trước khi ghi. Không tuyên bố List hay P3X tự giải quyết mọi lỗi đồng thời.

## 6. Giám sát server

Trên P3X mở Monitoring/Statistics và đối chiếu Console:

```redis
INFO server
INFO memory
INFO stats
INFO persistence
DBSIZE
```

INFO memory là bộ nhớ toàn Redis Server (gồm các DB và chi phí Redis), không chỉ riêng dữ liệu DB 1. DBSIZE chỉ đếm DB đang chọn, có cả key xác thực. Stream là lịch sử ứng dụng, không phải log lỗi toàn Redis Server.

## 7. Import/export trên P3X

Bản P3X và GUI Angular/React có thể bố trí menu khác nhau. Dùng menu thao tác key/Export/Import của bản đang cài, kiểm tra phạm vi đang chọn trước khi xuất.

1. Tạo bộ lab:, chọn key hoặc phạm vi thực hành cần xuất.
2. Xuất bằng chính tính năng Export của P3X; lưu tệp riêng.
3. Kết nối/đổi sang DB 3 đang trống hoặc Redis thử riêng. Kiểm tra DBSIZE = 0.
4. Import chính tệp P3X vừa xuất, xem preview và xử lý xung đột theo giao diện nếu có; tránh overwrite dữ liệu có sẵn.
5. Đối chiếu TYPE, giá trị, số phần tử, TTL. TTL đã hết hạn có thể khiến key không còn sau nhập.

Không nhập một JSON tự viết tùy ý và khẳng định đó là định dạng P3X. Nếu không tìm thấy tính năng trên bản đang cài, ghi rõ giới hạn phiên bản, chụp giao diện thực tế và dùng phương án CLI bổ sung dưới đây. Chưa có bằng chứng thao tác P3X thì không đánh dấu bài này đã hoàn tất.

### Phương án CLI bổ sung

Dừng nhận đơn, đợi processing trống và không sửa dữ liệu trong lúc xuất:

```powershell
node scripts/data-transfer.js export backups/business.json
$env:IMPORT_REDIS_URL='redis://127.0.0.1:6379/3'
node scripts/data-transfer.js import backups/business.json
Remove-Item Env:IMPORT_REDIS_URL
```

File định dạng `redis-lab-dump-v1`, lưu DUMP base64 + thời điểm hết hạn tuyệt đối. Đây là định dạng công cụ của đồ án, **không phải P3X JSON**. Chỉ xuất business/lab keys, không xuất auth:*; dùng để kiểm chứng trên DB trống, không phải bản sao toàn ứng dụng. Nếu input không tin cậy hoặc lỗi RESTORE giữa chừng, DB thử có thể nhập một phần; không có rollback Lua. Chỉ dùng bản xuất cục bộ tin cậy.

## 8. Backup và restore

RDB là snapshot Redis Server tại thời điểm lưu, chứa nhiều DB. AOF là nhật ký lệnh ghi theo cấu hình appendfsync, không phải lịch sử `order:events`. Không suy ra AOF bật chỉ vì Redis hỗ trợ nó.

Trên P3X:

```redis
INFO persistence
CONFIG GET dir
CONFIG GET dbfilename
BGSAVE
INFO persistence
```

Đợi rdb_bgsave_in_progress:0 và rdb_last_bgsave_status:ok. Trong PowerShell có thể dùng `scripts/backup-rdb.ps1` để BGSAVE, đợi xong, docker cp và ghi SHA256. Script không thay đổi cấu hình save/AOF.

Phục hồi bằng `scripts/restore-rdb.ps1 -BackupDirectory <thu-muc-backup>`: tạo container Redis mới, cùng image/tag nguồn, cổng 6381; dữ liệu nguồn giữ nguyên. Thêm kết nối P3X `127.0.0.1:6381`, chọn cùng DB rồi đối chiếu Hash/List/Set/ZSet/Stream. Key đã hết hạn theo thời gian thực sẽ không còn. Không khởi chạy worker/ứng dụng trên bản restore trong lúc đối chiếu.

## 9. Nguồn chính thức

- P3X Redis UI: https://github.com/patrikx3/redis-ui
- P3X changelog (khác biệt tính năng theo phiên bản): https://github.com/patrikx3/redis-ui/blob/main/change-log.md
- Redis commands: https://redis.io/docs/latest/commands/
- Redis Lua và tính nguyên tử: https://redis.io/docs/latest/develop/programmability/eval-intro/
- Redis DUMP: https://redis.io/docs/latest/commands/dump/
- Redis RESTORE và TTL: https://redis.io/docs/latest/commands/restore/
- Redis persistence: https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/
