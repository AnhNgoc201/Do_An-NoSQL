# Quản lý hàng đợi xử lý đơn hàng trực tuyến

## Chạy

Mở Docker Desktop, chạy trong CMD:

```bat
docker start redis-orders
cd /d D:\Hoc_Tap\NoSQL\NoSQL_DoAn\order-queue-app
npm start
```

Lần đầu npm install. Cấu hình Redis, tài khoản quản trị, thời gian xử lý mặc định trong .env. Không công khai .env.

- Khách: http://localhost:3000
- Quản trị: http://localhost:3000/admin.html
- Hàng đợi: http://localhost:3000/admin.html#queue
- Đóng gói / giao hàng: http://localhost:3000/fulfillment.html
- Tạo tài khoản nhân viên (admin): http://localhost:3000/fulfillment.html#team
- Kiểm tra Redis: http://localhost:3000/api/health

## Quy trình đơn hàng

1. Khách đặt đơn: server tính giá, lưu Hash đơn và RPUSH vào order:queue.
2. Worker LMOVE sang order:processing, kiểm tra toàn bộ tồn theo size.
3. Đủ hàng: xác nhận COMPLETED (Chờ đóng gói), trừ toàn bộ kho đúng một lần, thông báo khách và RPUSH sang fulfillment:packing:queue.
4. Thiếu hàng: chuyển WAITING_STOCK, báo admin và khách. Không trừ kho, không đếm thử lại 3 lần và không chiếm worker.
5. Hệ thống kiểm tra lại tồn kho tự động (kể cả cập nhật từ P3X). Khi đủ toàn bộ hàng trong 24 giờ **từ thời điểm đặt đơn**, đơn được xếp lại cuối queue để kiểm tra và xác nhận. Không giữ chỗ tồn kho trong thời gian chờ; nếu có cạnh tranh kho, worker kiểm tra lại nguyên tử trước khi trừ.
6. Sau 24 giờ: vẫn WAITING_STOCK, báo admin cần quyết định; không tự hủy và không tự xác nhận muộn. Mốc 24 giờ không được đặt lại khi khởi động lại hoặc kiểm tra nhiều lần.
7. Admin bấm Hủy đơn, nhập lý do. Đơn CANCELLED được gỡ khỏi queue/processing/chờ kho, gửi thông báo và lý do cho khách. Đơn đã xác nhận không hủy qua chức năng này; đơn đang xử lý bị hủy trước khi trừ kho sẽ được finish bỏ qua.

Worker có một tiến trình local. Thanh chỉnh 1–60 giây áp dụng từ đơn nhận tiếp theo và lưu settings:worker:delayMs. Nút tạm dừng chỉ ngừng nhận xử lý đơn; việc theo dõi chờ hàng vẫn hoạt động. Đơn đang xử lý giữ thời gian ban đầu. Cần backend và Redis hoạt động để tự xác nhận; khi khởi động lại, hệ thống đọc trạng thái/mốc chờ từ Redis và tiếp tục.

COMPLETED là xác nhận đủ hàng, chưa phải giao hàng hoặc thanh toán thật. Ứng dụng chưa tích hợp cổng thanh toán/email/SMS; thông báo hiển thị trong web qua chuông và lịch sử đơn của đúng tài khoản.

## Thông báo

- Admin: thiếu hàng, hết 24 giờ, xác nhận, hủy hoặc lỗi dữ liệu.
- Khách: chờ hàng, xác nhận và hủy kèm lý do; không thấy thông báo của khách khác.
- Chuông cập nhật mỗi 3 giây khi trang đang mở; thông báo lưu trong Redis nên đăng nhập lại vẫn xem được. Đánh dấu đã đọc lưu theo tài khoản.
- Thiếu hàng/hết hạn chỉ phát thông báo khi chuyển trạng thái lần đầu, không tạo lại mỗi lượt quét.

## Dữ liệu Redis và P3X

Kết nối P3X desktop vào 127.0.0.1:6379, chọn DB 1 (hoặc DB thật tại /api/health). DB 0 là bộ mẫu cũ, giữ riêng.

| Key | Kiểu | Vai trò |
|---|---|---|
| product:<id>, customer:<id>, order:<id> | Hash | Thông tin và trạng thái nghiệp vụ |
| order:queue, order:processing | List | FIFO và giữ đơn đang xử lý |
| order:status:<status> | Set | Chỉ mục PENDING / PROCESSING / WAITING_STOCK / COMPLETED / PACKING / READY_TO_SHIP / SHIPPING / DELIVERED / FAILED / CANCELLED |
| order:created | Sorted Set | Thời gian đặt, mili giây |
| order:stock-wait | Sorted Set | Hạn 24 giờ của đơn đang chờ/xếp lại; key hết hạn chờ được bỏ khỏi chỉ mục thời hạn nhưng vẫn giữ trạng thái WAITING_STOCK chờ admin |
| order:events | Stream | Nhật ký xử lý, không phải queue consumer group |
| fulfillment:packing:queue / active | List | Chờ / đang đóng gói |
| fulfillment:shipping:queue / active | List | Chờ / đang giao hàng |
| notification:admin, notification:user:<id> | Stream | Thông báo theo quyền, giữ khoảng 200 mục mỗi luồng |
| notification:read:<userId> | String | Mốc thông báo đã đọc |
| settings:worker:delayMs | String | Thời gian xử lý đã lưu |
| auth:* | Hash/String | Tài khoản và phiên, không công khai |

Hash đơn chờ có stockWaitStartedAt, stockWaitDeadlineAt, stockWaitExpired. Hạn được tính từ createdAtMs hoặc chỉ mục order:created của đơn cũ. Không dùng TTL xóa đơn. Đơn thiếu kho cũ FAILED/RETRYING được chuyển sang WAITING_STOCK khi khởi động bản mới, giữ mốc đặt ban đầu. Nếu đã quá 24 giờ thì báo admin, không tự xác nhận.

## Kiểm thử

```powershell
docker run --rm -d --name redis-stock-qa -p 127.0.0.1:16381:6379 redis:7.4
$env:TEST_REDIS_URL='redis://127.0.0.1:16381/1'
npm test
docker stop redis-stock-qa
Remove-Item Env:TEST_REDIS_URL
```

Chỉ dùng Redis thử rỗng. Kiểm tra FIFO, thiếu kho, không âm kho, đơn nhiều món, resume processing, phân quyền, sửa/xóa sản phẩm, 24h chờ kho, cập nhật kho, hạn chờ cố định, hủy trong lúc xử lý, thông báo riêng tư và đã đọc. Các bài biên 24h thay timestamp trong DB thử để kiểm chứng, không chờ thực tế 24 giờ.

## Backup và công cụ bổ sung

scripts/backup-rdb.ps1 tạo RDB và checksum; scripts/restore-rdb.ps1 phục hồi sang Redis thử riêng, không ghi đè nguồn. RDB chứa mọi DB và thông tin đăng nhập, cần giữ riêng.

scripts/data-transfer.js xuất/nhập logic business key bằng định dạng riêng redis-lab-dump-v1, không phải P3X JSON và không phải bản sao toàn ứng dụng. Bản logic không bao gồm auth:, notification:, settings:. Import chỉ vào DB >= 2 trống, chỉ dùng file cục bộ tin cậy; lỗi RESTORE giữa chừng không rollback. Tạm dừng worker và ngừng thay đổi dữ liệu khi xuất. Tài liệu cũ trong docs có ghi chú lỗi thời, không mô tả chính sách hiện tại.


## Đóng gói và giao hàng

Luồng: PENDING → PROCESSING → COMPLETED (Chờ đóng gói) → PACKING → READY_TO_SHIP → SHIPPING → DELIVERED.

Admin mở Vận hành → Nhân viên, tạo tài khoản bộ phận Kho hoặc Giao hàng với mật khẩu tối thiểu 12 ký tự. Không có tài khoản nhân viên/mật khẩu mặc định. Nhân viên đăng nhập ở cùng trang đăng nhập và tự được chuyển vào không gian phụ trách. Admin có thể thao tác cả hai công đoạn và hoàn tất thay nhân viên.

- Nhận đơn tiếp theo: Lua LMOVE đầu hàng đợi sang List đang thực hiện, lưu người phụ trách và cập nhật chỉ mục trạng thái/sự kiện nguyên tử. Hai nhân viên không thể nhận cùng một đơn. Mỗi nhân viên chỉ nhận một việc đang làm cho mỗi công đoạn; bấm lại trả về việc hiện tại.
- Kho bấm Đã đóng gói xong: READY_TO_SHIP và RPUSH sang hàng đợi giao hàng.
- Nhân viên giao bấm Nhận đơn tiếp theo: SHIPPING. Khi thực sự giao xong, bấm Đã giao thành công: DELIVERED.
- Chỉ người đã nhận hoặc admin được hoàn tất. Khách không thể gọi API vận hành; nhân viên không được quản trị sản phẩm, đọc mọi đơn hoặc tạo nhân viên khác. Hoàn tất lặp lại không thêm sự kiện/thông báo hoặc enqueue trùng.
- Các bước đóng gói/giao hàng không trừ kho lần nữa. Khách theo dõi trạng thái, thời điểm giao và thông báo riêng trong tài khoản.
- Danh sách chờ/đang làm và phân công được lưu Redis, giữ qua lần đăng nhập và restart. Đơn COMPLETED cũ chưa có fulfillmentQueuedAt được thêm vào hàng đợi đóng gói một lần khi khởi động, theo thời gian xác nhận, không trừ lại kho.
- Đây là cập nhật công việc bởi nhân viên. Chưa kết nối API đơn vị vận chuyển, chưa có luồng hoàn hàng/giao thất bại/đối soát COD. Công cụ xuất logic cũ chỉ bao gồm product/customer/order/lab, không chứa fulfillment/auth nên không dùng làm bản khôi phục toàn bộ ứng dụng.

Kiểm thử bổ sung (bắt buộc DB thử trống riêng):

```powershell
$env:TEST_FULFILLMENT_REDIS_URL='redis://127.0.0.1:16382/4'
node test-fulfillment.js
```

Tệp test dùng cổng 13011 cho server riêng và dừng server khi xong. Bao gồm phân quyền, nhận đồng thời, FIFO, nhận lại việc đang làm, hoàn tất lặp, thông báo riêng, không trừ kho hai lần, chuyển đơn cũ và kiểm tra sai kiểu key trước ghi.
