import { compare_time, render } from "luamark";

const N = 1000;

const arr: number[] = [];
const brr: number[] = [];
const crr: number[] = [];
for (const i of $range(1, N)) {
  arr[i - 1] = i;
  brr[i - 1] = i * 2;
  crr[i - 1] = i * 3;
}

print("=== Loop Rebase ===");
print(
  render(
    compare_time({
      "single array read": () => {
        let _sum = 0;
        for (const i of $range(0, N - 1)) {
          _sum += arr[i];
        }
      },
      "multiple array reads": () => {
        let _sum = 0;
        for (const i of $range(0, N - 1)) {
          _sum += arr[i] + brr[i] + crr[i];
        }
      },
      "array write": () => {
        for (const i of $range(0, N - 1)) {
          arr[i] = 0;
        }
      },
    }),
  ),
);
