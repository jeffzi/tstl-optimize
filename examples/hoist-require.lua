local ____req_bit_band = require("bit").band
flags = 65295
mask = 255
low = ____req_bit_band(flags, mask)
high = ____req_bit_band(flags, 61440)
print(low, high)
combined = require("bit").bor(flags, mask)
print(combined)
