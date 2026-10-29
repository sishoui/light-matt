declare function App<T>(options: T): void;
declare function Page<T>(options: T): void;

interface IAppOption {
  globalData: Record<string, never>;
}
