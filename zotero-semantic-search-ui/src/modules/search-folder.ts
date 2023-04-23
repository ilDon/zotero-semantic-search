export class SearchFolder {
  public static getSearchFolder() {
    return localStorage.getItem('search_folder');
  }
  
  public static setSearchFolder(folder: string) {
    localStorage.setItem('search_folder', folder);
  }
  public static deleteSearchFolder() {
      localStorage.removeItem('search_folder');
  }
}
