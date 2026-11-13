param([Parameter(Mandatory=$true)][string]$BackupDirectory,[string]$Name=('redis-lab-restore-'+(Get-Date -Format 'yyyyMMddHHmmss')),[int]$Port=6381)
$ErrorActionPreference='Stop'
if($Port -lt 1024 -or $Port -gt 65535 -or $Port -eq 6379 -or $Name -notmatch '^redis-lab-restore-[a-zA-Z0-9-]+$'){throw 'Dùng tên redis-lab-restore-* và cổng thử khác 6379.'}
$folder=[IO.Path]::GetFullPath($BackupDirectory)
$manifest=Get-Content -LiteralPath (Join-Path $folder 'manifest.json') -Raw | ConvertFrom-Json
$rdb=Join-Path $folder 'dump.rdb'
if((Get-FileHash -LiteralPath $rdb -Algorithm SHA256).Hash -ne $manifest.sha256){throw 'Checksum bản backup không khớp.'}
if($manifest.image -notmatch '^redis:[a-zA-Z0-9._-]+$'){throw 'Chỉ phục hồi bằng image redis chính thức có tag trong manifest.'}
& docker create --name $Name -p "127.0.0.1:${Port}:6379" $manifest.image redis-server --dir /data --dbfilename dump.rdb --appendonly no
if($LASTEXITCODE -ne 0){throw 'Không tạo được container mới; không sửa container đã tồn tại.'}
& docker cp $rdb "${Name}:/data/dump.rdb"
if($LASTEXITCODE -ne 0){throw 'Không sao chép được RDB vào container thử.'}
& docker start $Name
if($LASTEXITCODE -ne 0){throw 'Không khởi động được container thử.'}
$ready=$false
for($i=0;$i -lt 40;$i++){
    $reply=& docker exec $Name redis-cli PING 2>$null
    if($reply -eq 'PONG'){$ready=$true;break}
    Start-Sleep -Milliseconds 250
}
if(-not $ready){throw 'Redis thử chưa sẵn sàng; xem docker logs để kiểm tra file RDB.'}
Write-Output "Kết nối P3X: 127.0.0.1:$Port, chọn cùng DB với bản gốc. Container: $Name"
Write-Output 'Đối chiếu key, TYPE, giá trị, trạng thái và TTL trước/sau. Container nguồn được giữ nguyên.'
